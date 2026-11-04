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
from dataclasses import dataclass, field
from typing import Any

from strands.hooks import AfterToolCallEvent, BeforeToolCallEvent, HookProvider, HookRegistry


ENDED_MARKERS = ("###STOP###", "Conversation has already ended", "Conversation already ended")


@dataclass(frozen=True)
class Rule:
    kind: str  # requires | terminal | advice
    tool: str | None
    requires: str | None
    field: str | None
    explanation: str

    def describe(self) -> str:
        if self.kind == "requires":
            scope = f" for the same {self.field}" if self.field else ""
            return f"{self.tool} requires a successful {self.requires}{scope} first. {self.explanation}".strip()
        return self.explanation


@dataclass
class Trellis:
    rules: list[Rule] = field(default_factory=list)
    announce: bool = True
    enforce: bool = True

    def announcement(self) -> str | None:
        if not self.announce or not self.rules:
            return None
        lines = ["<policy-rules>", "  Rules enforced on your tool calls:"]
        lines.extend(f"  - {rule.describe()}" for rule in self.rules)
        lines.append("</policy-rules>")
        return "\n".join(lines)


def load_trellis(folder: str) -> Trellis:
    rules_path = os.path.join(folder, "rules.json")
    config_path = os.path.join(folder, "config.json")
    rules: list[Rule] = []
    if os.path.exists(rules_path):
        with open(rules_path) as f:
            for raw in json.load(f):
                rules.append(Rule(raw.get("kind", "requires"), raw.get("tool"), raw.get("requires"), raw.get("field"), raw.get("explanation", "")))
    config: dict[str, Any] = {}
    if os.path.exists(config_path):
        with open(config_path) as f:
            config = json.load(f)
    return Trellis(rules=rules, announce=config.get("announce", True), enforce=config.get("enforce", True))


class TrellisHook(HookProvider):
    """Denies a tool call whose prerequisite has not succeeded in this session."""

    def __init__(self, trellis: Trellis) -> None:
        self._rules = [r for r in trellis.rules if r.kind != "advice"]
        self._terminal = next((r for r in self._rules if r.kind == "terminal"), None)
        # Successful calls so far: tool name -> values seen for each input field.
        self._succeeded: dict[str, list[dict[str, Any]]] = {}
        self.ended = False
        self.denials = 0

    def register_hooks(self, registry: HookRegistry, **kwargs: Any) -> None:
        registry.add_callback(BeforeToolCallEvent, self._before)
        registry.add_callback(AfterToolCallEvent, self._after)

    def _before(self, event: BeforeToolCallEvent) -> None:
        name = event.tool_use["name"]
        inputs = event.tool_use.get("input") or {}
        if self.ended and self._terminal is not None:
            self.denials += 1
            event.cancel_tool = f"blocked by policy: {self._terminal.describe()}"
            return
        for rule in self._rules:
            if rule.kind != "requires" or rule.tool != name or self._satisfied(rule, inputs):
                continue
            self.denials += 1
            event.cancel_tool = f"blocked by policy: {rule.describe()}"
            return

    def _after(self, event: AfterToolCallEvent) -> None:
        if event.cancel_message or event.exception is not None:
            return
        if self._terminal is not None and any(m in _result_text(event.result) for m in ENDED_MARKERS):
            self.ended = True
        if event.result.get("status") != "success":
            return
        name = event.tool_use["name"]
        inputs = dict(event.tool_use.get("input") or {})
        self._succeeded.setdefault(name, []).append(inputs)

    def _satisfied(self, rule: Rule, inputs: dict[str, Any]) -> bool:
        assert rule.requires is not None
        prior = self._succeeded.get(rule.requires)
        if not prior:
            return False
        if rule.field is None or rule.field not in inputs:
            return True
        return any(call.get(rule.field) == inputs[rule.field] for call in prior)


def _result_text(result: Any) -> str:
    """Every text block of a tool result, joined; a result without text yields ''."""
    try:
        return " ".join(str(block.get("text", "")) for block in result.get("content", []) if isinstance(block, dict))
    except AttributeError:
        return ""
