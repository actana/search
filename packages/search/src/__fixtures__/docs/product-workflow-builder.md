# Workflow Builder

The workflow builder is the visual surface where a team assembles agent logic
out of blocks. A workflow is a directed graph: blocks are the nodes, and the
edges carry the output of one block into the inputs of the next.

## Blocks

Every block has a type, a set of sub-blocks that render its configuration
form, a declared input shape, and a declared output shape. A block does not
talk to an external service itself — it delegates to one or more tools, and a
tool owns the request shape, the authentication, and the response transform.

Blocks fall into three groups. Integration blocks wrap a third-party service
such as a mail provider or a ticket tracker. Utility blocks do local work:
branching on a condition, looping over a list, reshaping a payload, waiting for
a fixed interval. The four agent blocks run a model, generate speech, generate
video, or run a nested agent.

A sub-block can be shown or hidden by a condition on another sub-block's value,
so the form stays short: choosing an operation reveals only the fields that
operation needs. A sub-block can also declare a dependency, which clears its
value when the field it depends on changes — the usual case is a resource
picker that resets when the credential changes.

## Edges and references

An edge connects an output port of one block to an input port of another. A
field can also reference an upstream block's output inline, which is how a
subject line can interpolate a name fetched three blocks earlier. References
are resolved at execution time, after the graph is serialised, which is why a
block's tool selector must never coerce types: the reference is still a token
at that point and coercion destroys it.

Cycles are allowed only through an explicit loop block, which owns the
iteration variable and the exit condition. A graph with an accidental cycle
fails validation before it is saved.

## Running a workflow

The executor walks the graph breadth-first from the trigger, running every
block whose inputs are satisfied. Independent branches run concurrently. Each
block run produces a log entry with the resolved inputs, the raw response, the
transformed output, the duration, and the token cost where a model was called.

A run can be started manually from the builder, from a schedule, from an
incoming webhook, or by an agent calling the workflow as a tool. The trigger
block defines which of these is allowed and what the incoming payload looks
like.

## Versions and deployment

Saving a workflow updates the draft. Deploying takes a snapshot of the draft
and pins it as the live version; the live version is what schedules and
webhooks execute. The draft can then move ahead without disturbing anything in
production. Rolling back is selecting an earlier deployment and promoting it,
which takes effect on the next run.

Deployments are immutable. The stored snapshot includes the block graph, the
sub-block values, and the resolved tool versions, so a run from six months ago
can be explained exactly.

## Debugging

Debug mode runs the graph one block at a time and pauses after each, showing
the resolved inputs before the block executes. The run path is highlighted on
the canvas as it progresses, and a failed block is outlined with its error
message attached. Logs are retained for ninety days and are searchable by
workflow, by block type, and by error text.
