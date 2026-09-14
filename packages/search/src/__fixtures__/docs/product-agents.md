# Agents

An agent is a model, a system prompt, a set of tools, and the memory it is
allowed to read. Agents are created in the workspace, tested against saved
conversations, and then deployed behind a channel: a chat widget, a phone
number, an inbox, or an API key.

## Anatomy

The model is chosen per agent from the workspace's configured inference
endpoints. Swapping the model does not change anything else about the agent,
which is what makes a model migration a one-field change rather than a rewrite.

Tools are the actions an agent can take. A tool is either a workflow published
as a tool, a code tool written inline, or a tool exposed by a connected server
over the model context protocol. Each tool declares a name, a description, and
a parameter schema; the description is what the model actually reads, so it is
worth writing carefully.

Procedures are the agent's playbooks. A procedure is a short, ordered
description of how to handle a class of request, compiled into the system
prompt when it is relevant. Procedures keep prompts short by loading only what
the current conversation needs.

## Memory and knowledge

An agent can be attached to one or more knowledge bases. When attached, a
retrieval step runs before the model call and the retrieved passages are placed
in the context window with their source filenames. Attaching a knowledge base
never grants the agent write access to it.

Conversation memory is scoped to the channel and the end user. Summaries are
written back after each turn so a long conversation does not grow the context
window without bound.

## Branches and deployments

An agent has a live version and any number of branches. A branch is an
isolated copy of the configuration that can be edited and tested without
affecting the live agent. Merging a branch shows a field-by-field preview of
what will change before anything is written.

A deployment pins a version of the agent to a channel. Two channels can run
two different versions of the same agent at once, which is how a new prompt is
rolled out to a small audience first.

## Testing

A test is a saved conversation plus a set of assertions: the agent called this
tool, the reply mentioned this fact, the conversation was resolved within this
many turns. Tests run against a branch on demand or on every merge, and a run
reports pass, fail, and the transcript that produced each result.

Simulated conversations generate a plausible end-user side from a short
scenario description, which is how a test suite gets breadth without a human
writing every turn.

## Triage

When an agent cannot resolve a conversation it opens a triage ticket. A ticket
carries the transcript, the tools the agent tried, and the reason it stopped.
Tickets are assigned to a human, commented on, and closed; a closed ticket can
be promoted into a procedure so the same request resolves automatically next
time.
