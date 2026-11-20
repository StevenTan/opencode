export * as CollaborationTools from "./collaboration.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Option, Schema } from "effect"
import { Agent } from "../../agent.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import { SessionMessage } from "../../session/message.js"
import { SessionSchema } from "../../session/schema.js"
import type { ListCursor } from "@opencode/schema/session"

const target = Schema.NonEmptyString.annotate({
  description:
    "Session ID or agent_name path in the current root agent tree, or parent for the immediate parent. Absolute paths start at /root; relative paths start beneath the caller.",
})
const Send = Schema.Struct({ target, message: Schema.NonEmptyString })
const Target = Schema.Struct({ target })
const Wait = Schema.Struct({
  targets: Schema.Array(target).check(Schema.isMinLength(1)),
  timeout_ms: Schema.Int.check(Schema.isBetween({ minimum: 10000, maximum: 3600000 }))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(30000)))
    .annotate({ description: "Wait timeout in milliseconds. Prefer a longer wait over repeated polling." }),
})
const List = Schema.Struct({
  path_prefix: Schema.optionalKey(Schema.NonEmptyString).annotate({
    description:
      "Canonical or caller-relative agent path prefix, without a trailing slash. Omit to list the complete root tree.",
  }),
})
const WaitResult = Schema.Struct({
  session_id: SessionSchema.ID,
  status: Schema.Literal("idle"),
  output: Schema.String,
  error: SessionMessage.Assistant.fields.error,
  outcome: SessionSchema.Info.fields.outcome,
})

const canonicalPath = Effect.fn("CollaborationTools.path")(function* (current: string, value: string) {
  const path = value.startsWith("/") ? value : `${current}/${value}`
  if (!/^\/root(?:\/[^/.][^/]*)*$/.test(path))
    return yield* new ToolFailure({
      message: "Agent paths start at /root or beneath the caller, without trailing slashes or dot segments.",
    })
  return path
})

export const Plugin = {
  id: "opencode.tool.collaboration",
  effect: Effect.fn("CollaborationTools.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const permission = yield* Permission.Service
    const agents = yield* Agent.Service

    const lineage = Effect.fn("CollaborationTools.lineage")(function* (sessionID: SessionSchema.ID) {
      const chain = [yield* sessions.get(sessionID)]
      while (chain[0].parentID !== undefined) chain.unshift(yield* sessions.get(chain[0].parentID))
      return chain
    })
    const tree = Effect.fn("CollaborationTools.tree")(function* (sessionID: SessionSchema.ID) {
      const chain = yield* lineage(sessionID)
      const nodes = [{ session: chain[0], path: "/root" }]
      for (const node of nodes) {
        let cursor: ListCursor | undefined
        do {
          const page = yield* sessions.list({ parentID: node.session.id, cursor })
          nodes.push(...page.data.map((session) => ({ session, path: `${node.path}/${session.id}` })))
          cursor = page.cursor.next
        } while (cursor !== undefined)
      }
      return { nodes, path: ["/root", ...chain.slice(1).map((session) => session.id)].join("/") }
    })
    const resolve = Effect.fn("CollaborationTools.resolve")(function* (sessionID: SessionSchema.ID, target: string) {
      let recipient: SessionSchema.Info
      if (target === "parent") {
        const caller = yield* sessions.get(sessionID)
        if (!caller.parentID) return yield* new ToolFailure({ message: "The current session has no parent agent." })
        recipient = yield* sessions.get(caller.parentID)
      } else if (target.includes("/")) {
        const current = yield* tree(sessionID)
        const path = yield* canonicalPath(current.path, target)
        const node = current.nodes.find((node) => node.path === path)
        if (!node) return yield* new ToolFailure({ message: "Target is not in the current agent tree." })
        recipient = node.session
      } else {
        const [caller, destination] = yield* Effect.all([lineage(sessionID), lineage(SessionSchema.ID.make(target))])
        if (caller[0].id !== destination[0].id)
          return yield* new ToolFailure({ message: "Target is not in the current agent tree." })
        recipient = destination[destination.length - 1]
      }
      if (recipient.id === sessionID)
        return yield* new ToolFailure({ message: "Target must be another agent in the same agent tree." })
      return recipient
    })
    const identity = Effect.fn("CollaborationTools.identity")(function* (recipient: SessionSchema.Info) {
      if (recipient.agent !== undefined) return recipient.agent
      if (recipient.parentID !== undefined) return yield* new ToolFailure({ message: "Target has no assigned agent." })
      return (yield* agents.select()).id
    })
    const approve = Effect.fn("CollaborationTools.approve")(function* (
      recipient: SessionSchema.Info,
      context: ReturnType<typeof Permission.invocation>,
      action = "subagent",
    ) {
      const agent = yield* identity(recipient)
      yield* permission.assert({ action, resources: [agent], save: [agent], ...context })
      return agent
    })

    yield* ctx.tool
      .transform((editor) => {
        editor.namespace({
          name: "collaboration",
          description: "Tools for coordinating agents in the current root tree.",
        })
        editor.add({
          name: "send_input",
          options: { namespace: "collaboration", codemode: false, permission: "subagent" },
          description:
            "Give an existing non-root agent in the current root tree a follow-up task, preserving its agent, model and history. Returns immediately; wakes an idle agent or steers a running one. Completion notifications go to its actual parent, identified by result_recipient. Use wait_agent to collect a result directly, or send_message for a message that does not start a new turn.",
          input: Send,
          output: Schema.Struct({ session_id: SessionSchema.ID, result_recipient: SessionSchema.ID }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const recipient = yield* resolve(context.sessionID, input.target)
              if (!recipient.parentID)
                return yield* new ToolFailure({
                  message: "Target must be a non-root agent. Use send_message to contact the root agent.",
                })
              yield* approve(recipient, Permission.invocation(context))
              yield* sessions.prompt({ sessionID: recipient.id, text: input.message })
              const output = { session_id: recipient.id, result_recipient: recipient.parentID }
              return { output, content: JSON.stringify(output) }
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error }))),
        })
        editor.add({
          name: "send_message",
          options: { namespace: "collaboration", codemode: false, permission: "collaboration_send_message" },
          description:
            "Send a message to another agent in the current root tree, including parent or /root. The message is queued for its next boundary; an idle recipient stays idle. This does not start a new turn. Use send_input to assign a task and wake an agent.",
          input: Send,
          output: Schema.Struct({ session_id: SessionSchema.ID, message_id: SessionMessage.ID }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const recipient = yield* resolve(context.sessionID, input.target)
              yield* approve(recipient, Permission.invocation(context), "collaboration_send_message")
              const messageID = SessionMessage.ID.create()
              yield* sessions.synthetic({
                sessionID: recipient.id,
                id: messageID,
                text: `<agent-message from="${context.sessionID}">\n${input.message}\n</agent-message>`,
                description: "Agent message",
                metadata: { source: "agent-message", senderID: context.sessionID },
                resume: false,
              })
              const output = { session_id: recipient.id, message_id: messageID }
              return { output, content: JSON.stringify(output) }
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error }))),
        })
        editor.add({
          name: "wait_agent",
          options: { namespace: "collaboration", codemode: false, permission: "subagent" },
          description:
            "Wait for any specified agent in the current root tree to become idle. Returns timed_out and result with its latest assistant text, error and execution outcome. Idle includes completion, failure and interruption. A timeout or cancelled wait leaves the agents running. Native parent notifications remain active.",
          input: Wait,
          output: Schema.Union([
            Schema.Struct({ timed_out: Schema.Literal(true), result: Schema.Null }),
            Schema.Struct({ timed_out: Schema.Literal(false), result: WaitResult }),
          ]),
          execute: (input, context) =>
            Effect.gen(function* () {
              const targets = yield* Effect.forEach(input.targets, (target) => resolve(context.sessionID, target))
              yield* Effect.forEach(targets, (recipient) => approve(recipient, Permission.invocation(context)))
              const result = yield* Effect.raceAllFirst(
                targets.map((recipient) =>
                  Effect.gen(function* () {
                    yield* sessions.wait(recipient.id)
                    const info = yield* sessions.get(recipient.id)
                    const [assistant] = yield* sessions.messages({
                      sessionID: recipient.id,
                      type: "assistant",
                      order: "desc",
                      limit: 1,
                    })
                    return {
                      session_id: recipient.id,
                      status: "idle" as const,
                      output:
                        assistant?.type === "assistant"
                          ? assistant.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n")
                          : "",
                      error: assistant?.type === "assistant" ? assistant.error : undefined,
                      outcome: info.outcome,
                    }
                  }),
                ),
              ).pipe(Effect.timeoutOption(input.timeout_ms))
              const output = Option.isNone(result)
                ? { timed_out: true as const, result: null }
                : { timed_out: false as const, result: result.value }
              return { output, content: JSON.stringify(output) }
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error }))),
        })
        editor.add({
          name: "interrupt_agent",
          options: { namespace: "collaboration", codemode: false, permission: "subagent" },
          description:
            "Interrupt another agent in the current root tree without deleting its session. Returns whether interruption was accepted. Use wait_agent to wait for idle or send_input to give a non-root agent another task.",
          input: Target,
          output: Schema.Struct({ session_id: SessionSchema.ID, interrupted: Schema.Boolean }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const recipient = yield* resolve(context.sessionID, input.target)
              yield* approve(recipient, Permission.invocation(context))
              const interrupted = yield* sessions.interrupt(recipient.id, { resume: false })
              const output = { session_id: recipient.id, interrupted }
              return { output, content: JSON.stringify(output) }
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error }))),
        })
        editor.add({
          name: "list_agents",
          options: { namespace: "collaboration", codemode: false, permission: "subagent" },
          description:
            "List agents in the current root tree, including /root and the caller, optionally restricted by path_prefix. Each entry includes session_id, parent_id, agent_name path, title, effective agent and current status. Use wait_agent or native completion notifications to wait for results.",
          input: List,
          output: Schema.Struct({
            agents: Schema.Array(
              Schema.Struct({
                session_id: SessionSchema.ID,
                parent_id: Schema.NullOr(SessionSchema.ID),
                agent_name: Schema.String,
                title: Schema.NullOr(Schema.String),
                agent: Agent.ID,
                status: Schema.Literals(["running", "idle", "completed", "errored", "interrupted"]),
              }),
            ),
          }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const current = yield* tree(context.sessionID)
              const prefix =
                input.path_prefix === undefined ? "/root" : yield* canonicalPath(current.path, input.path_prefix)
              const active = yield* sessions.active
              const agents = yield* Effect.forEach(
                current.nodes.filter(
                  (node) =>
                    (node.session.parentID === undefined || node.session.agent !== undefined) &&
                    (node.path === prefix || node.path.startsWith(`${prefix}/`)),
                ),
                (node) =>
                  Effect.gen(function* () {
                    const agent = node.session.id === context.sessionID ? context.agent : yield* identity(node.session)
                    const status = active.has(node.session.id)
                      ? ("running" as const)
                      : node.session.outcome === "succeeded"
                        ? ("completed" as const)
                        : node.session.outcome === "failed"
                          ? ("errored" as const)
                          : (node.session.outcome ?? ("idle" as const))
                    return {
                      session_id: node.session.id,
                      parent_id: node.session.parentID ?? null,
                      agent_name: node.path,
                      title: node.session.title ?? null,
                      agent,
                      status,
                    }
                  }),
              )
              yield* Effect.forEach(
                new Set(agents.filter((agent) => agent.session_id !== context.sessionID).map((agent) => agent.agent)),
                (agent) =>
                  permission.assert({
                    action: "subagent",
                    resources: [agent],
                    save: [agent],
                    ...Permission.invocation(context),
                  }),
              )
              const output = { agents }
              return { output, content: JSON.stringify(output) }
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error }))),
        })
      })
      .pipe(Effect.orDie)
  }),
}
