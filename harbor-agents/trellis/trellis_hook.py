"""Trellis constraints for a Strands agent: announce them, and optionally enforce them.

Rules come from ``rules.json``; whether they are announced in the system prompt and whether
they deny calls comes from ``config.json``. Both live next to this file, so an arm of the
experiment is a commit of this folder. Three kinds of rule:

- ``requires``: a tool needs an earlier successful call to another tool, optionally on the
  same value of one input field. Denied until the prerequisite has succeeded.
- ``terminal``: once a tool result shows the conversation has ended (the user's
  ``###STOP###`` or the server's "already ended" error), every further call is denied.
- ``advice``: announced only; nothing is denied.

Enforcement is a before-tool-call hook that cancels the call with a message naming the rule,
so the agent can act on it. Outcomes are tracked from the after-tool-call hook.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import Any

from strands.hooks import AfterToolCallEvent, BeforeToolCallEvent, HookProvider, HookRegistry


ENDED_MARKERS = ("###STOP###", "Conversation has already ended", "Conversation already ended")

# ALFWorld exposes one free-text `step(action)` tool. Rules name the verb inside it
# (`go_to`, `take`, `put`, ...) and bind on `object` / `receptacle`; a "Nothing happens."
# result is a failed step even though the tool itself did not error.
ALFWORLD_ACTION = re.compile(r"^\s*(go to|open|close|take|put|move|clean|heat|cool|use|examine|look|inventory)\b\s*(.*)$", re.I)
ALFWORLD_FAILED = re.compile(r"^\s*(Nothing happens|Episode already finished|Episode not started)")


def parse_alfworld_action(action: str) -> tuple[str, dict[str, Any]] | None:
    m = ALFWORLD_ACTION.match(action)
    if not m:
        return None
    verb = m.group(1).lower().replace(" ", "_")
    rest = m.group(2).strip().lower()
    inputs: dict[str, Any] = {}

    def split(sep: str) -> None:
        parts = re.split(sep, rest, maxsplit=1)
        if parts and parts[0]:
            inputs["object"] = parts[0].strip()
        if len(parts) > 1 and parts[1]:
            inputs["receptacle"] = parts[1].strip()

    if verb in ("go_to", "open", "close", "examine"):
        if rest:
            inputs["receptacle"] = rest
    elif verb == "take":
        split(r"\s+from\s+")
    elif verb == "put":
        split(r"\s+in/on\s+|\s+in\s+|\s+on\s+")
    elif verb == "move":
        split(r"\s+to\s+")
    elif verb in ("clean", "heat", "cool"):
        split(r"\s+with\s+")
    elif verb == "use" and rest:
        inputs["object"] = rest
    return verb, inputs


def _effective_call(name: str, inputs: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """The call a rule sees: ALFWorld's `step` unfolds to its verb; everything else is itself.

    A verb outside the known grammar (`drop`, `place`, ...) still becomes the verb, with no
    parsed arguments, so a format rule can name it.
    """
    if name == "step" and isinstance(inputs.get("action"), str):
        parsed = parse_alfworld_action(inputs["action"])
        if parsed:
            return parsed
        first = inputs["action"].strip().split(" ", 1)[0].lower()
        if first:
            return first, {}
    return name, inputs


@dataclass(frozen=True)
class Rule:
    kind: str  # requires | terminal | format | advice
    tools: tuple[str, ...]  # targets; empty for terminal/advice
    requires: tuple[str, ...]  # any one of these satisfies the prerequisite
    field: str | None
    explanation: str
    announce: bool
    pattern: str | None = None  # format: regex the call text must match (ALFWorld: the action string)

    def describe(self, tool: str | None = None) -> str:
        if self.kind == "requires":
            scope = f" for the same {self.field}" if self.field else ""
            subject = tool if tool is not None else " / ".join(self.tools)
            return f"{subject} requires a successful {' or '.join(self.requires)}{scope} first. {self.explanation}".strip()
        return self.explanation


@dataclass
class Trellis:
    rules: list[Rule] = field(default_factory=list)
    announce: bool = True
    enforce: bool = True
    # Append a compact record of every tool call to the agent's final message, inside
    # <trellis-trace>...</trellis-trace>. Harbor stores that message in its results database,
    # which makes the trace readable without the budget-gated trace analysis. The appendix is
    # added after the episode has ended, so it cannot affect the task outcome.
    trace_in_output: bool = False

    def announcement(self) -> str | None:
        # A termination rule is never announced: telling the model when the conversation
        # is over changes how it converses. It enforces silently.
        announced = [r for r in self.rules if r.announce and r.kind != "terminal"]
        if not self.announce or not announced:
            return None
        lines = ["<policy-rules>", "  Rules enforced on your tool calls:"]
        lines.extend(f"  - {rule.describe()}" for rule in announced)
        lines.append("</policy-rules>")
        return "\n".join(lines)


def load_trellis(folder: str) -> Trellis:
    rules_path = os.path.join(folder, "rules.json")
    config_path = os.path.join(folder, "config.json")
    rules: list[Rule] = []
    if os.path.exists(rules_path):
        with open(rules_path) as f:
            for raw in json.load(f):
                tools = raw.get("tools") or ([raw["tool"]] if raw.get("tool") else [])
                requires = raw.get("requires_any") or ([raw["requires"]] if raw.get("requires") else [])
                rules.append(Rule(raw.get("kind", "requires"), tuple(tools), tuple(requires), raw.get("field"),
                                  raw.get("explanation", ""), bool(raw.get("announce", raw.get("kind", "requires") != "terminal")),
                                  raw.get("pattern")))
    config: dict[str, Any] = {}
    if os.path.exists(config_path):
        with open(config_path) as f:
            config = json.load(f)
    return Trellis(rules=rules, announce=config.get("announce", True), enforce=config.get("enforce", True),
                   trace_in_output=bool(config.get("trace_in_output", False)))


class TrellisHook(HookProvider):
    """Denies a tool call whose prerequisite has not succeeded in this session."""

    def __init__(self, trellis: Trellis) -> None:
        self._rules = [r for r in trellis.rules if r.kind != "advice"]
        self._terminal = next((r for r in self._rules if r.kind == "terminal"), None)
        # Successful calls so far: tool name -> values seen for each input field.
        self._succeeded: dict[str, list[dict[str, Any]]] = {}
        self.ended = False
        self.denials = 0
        # [tool, argument summary, ok, denied] per call, in order.
        self.trace: list[list[Any]] = []

    def register_hooks(self, registry: HookRegistry, **kwargs: Any) -> None:
        registry.add_callback(BeforeToolCallEvent, self._before)
        registry.add_callback(AfterToolCallEvent, self._after)

    def _before(self, event: BeforeToolCallEvent) -> None:
        name, inputs = _effective_call(event.tool_use["name"], event.tool_use.get("input") or {})
        if self.ended and self._terminal is not None:
            self.denials += 1
            self.trace.append([name, _summary(event.tool_use.get("input") or {}), 0, 1])
            event.cancel_tool = f"blocked by policy: {self._terminal.describe()}"
            return
        for rule in self._rules:
            if name not in rule.tools:
                continue
            if rule.kind == "format":
                text = _call_text(event.tool_use["name"], event.tool_use.get("input") or {})
                if rule.pattern is not None and re.search(rule.pattern, text, re.I):
                    continue
            elif rule.kind != "requires" or self._satisfied(rule, inputs):
                continue
            self.denials += 1
            self.trace.append([name, _summary(event.tool_use.get("input") or {}), 0, 1])
            event.cancel_tool = f"blocked by policy: {rule.describe(name)}"
            return

    def _after(self, event: AfterToolCallEvent) -> None:
        if event.cancel_message:
            return  # recorded as a denial in _before
        raw_name = event.tool_use["name"]
        raw_input = dict(event.tool_use.get("input") or {})
        text = _result_text(event.result) if event.exception is None else str(event.exception)
        ok = event.exception is None and event.result.get("status") == "success"
        if raw_name == "step" and ALFWORLD_FAILED.match(text):
            ok = False  # the environment rejected the action: not a success for prerequisite purposes
        self.trace.append([raw_name, _summary(raw_input), 1 if ok else 0, 0])
        if event.exception is not None:
            return
        if self._terminal is not None and any(m in text for m in ENDED_MARKERS):
            self.ended = True
        if not ok:
            return
        name, inputs = _effective_call(raw_name, raw_input)
        self._succeeded.setdefault(name, []).append(dict(inputs))

    def trace_block(self) -> str:
        """The recorded calls as a tagged JSON appendix for the final message."""
        return "\n\n<trellis-trace>" + json.dumps(self.trace, separators=(",", ":")) + "</trellis-trace>"

    def _satisfied(self, rule: Rule, inputs: dict[str, Any]) -> bool:
        prior = [call for tool in rule.requires for call in self._succeeded.get(tool, [])]
        if not prior:
            return False
        if rule.field is None or rule.field not in inputs:
            return True
        return any(call.get(rule.field) == inputs[rule.field] for call in prior)


def _call_text(name: str, inputs: dict[str, Any]) -> str:
    """What a format rule matches against: ALFWorld's action string, else the JSON of the inputs."""
    if name == "step" and isinstance(inputs.get("action"), str):
        return inputs["action"]
    return json.dumps(inputs, sort_keys=True)


def _summary(inputs: dict[str, Any]) -> Any:
    """A tool call's arguments, kept short: ALFWorld's action string as-is, otherwise scalar fields."""
    if isinstance(inputs.get("action"), str) and len(inputs) == 1:
        return inputs["action"][:80]
    return {k: (v[:60] if isinstance(v, str) else v) for k, v in inputs.items() if isinstance(v, (str, int, float, bool))}


def attach_trace_to_output(agent: Any, hook: "TrellisHook") -> None:
    """Make the agent's final message carry the hook's trace. Wraps invoke_async in place."""
    original = agent.invoke_async

    async def invoke_async(*args: Any, **kwargs: Any) -> Any:
        result = await original(*args, **kwargs)
        try:
            content = result.message.get("content")
            if isinstance(content, list):
                content.append({"text": hook.trace_block()})
        except Exception:  # noqa: BLE001 - a missing trace must never fail the trial
            pass
        return result

    agent.invoke_async = invoke_async


def _result_text(result: Any) -> str:
    """Every text block of a tool result, joined; a result without text yields ''."""
    try:
        return " ".join(str(block.get("text", "")) for block in result.get("content", []) if isinstance(block, dict))
    except AttributeError:
        return ""
