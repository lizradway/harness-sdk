# Trellis agent for Harbor (`strands-custom`)

Harbor's strandsharness wrapper plus Trellis constraints. `rules.json` holds the constraints
(mined offline from baseline traces), `config.json` whether they are announced in the system
prompt and enforced before tool calls. An empty `rules.json` is the baseline agent.

Launch: `harness="strands-custom"`, `agent_source={"repo": ..., "sha": ..., "path": "harbor/trellis-agent", "module": "agent:MyAgent"}`.
