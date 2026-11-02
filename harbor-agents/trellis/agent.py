"""strandsharness agent plus Trellis constraints, for Harbor's strands-custom harness.

Harbor's own strandsharness wrapper, unchanged except for one addition: the constraints in
``rules.json`` next to this file are announced in the system prompt and, when ``config.json``
says so, enforced before each tool call by ``trellis_hook.TrellisHook``. With an empty
``rules.json`` the agent is the baseline.
"""

import base64
import json
import os
from functools import partial

from strands import Agent
from strands.tools.executors import SequentialToolExecutor
from strands_harness import create_harness

from trellis_hook import TrellisHook, load_trellis

_MANTLE_ROUTE_PREFIX = "openai."
_MANTLE_OPENAI_VENDOR_PREFIX = "openai.gpt"
_MANTLE_HOST = "bedrock-mantle."
_MANTLE_ANTHROPIC_BUILTIN_TOOLS = {"web_search": False}


def _task_instructions(task_workdir: str | None) -> str | None:
    if not task_workdir:
        return None
    return (
        f"You are working inside a benchmark task container. The task root is {task_workdir}. "
        "Run `pwd` before acting, resolve task files relative to that root, and use absolute paths "
        "when writing or editing files."
    )


def _mantle_endpoint_model_id(model_id: str) -> str:
    if model_id.startswith(_MANTLE_OPENAI_VENDOR_PREFIX):
        return model_id
    return model_id.removeprefix(_MANTLE_ROUTE_PREFIX)


def _resolve_model():
    model_id = os.environ.get("STRANDS_MODEL")
    if not model_id:
        return None
    if model_id.startswith(_MANTLE_ROUTE_PREFIX):
        mantle_config = {"region": os.environ.get("AWS_REGION", "us-east-1")}
        if "gpt-5" in model_id:
            from strands.models.openai_responses import OpenAIResponsesModel

            return OpenAIResponsesModel(model_id=model_id, bedrock_mantle_config=mantle_config)
        else:
            from strands.models.openai import OpenAIModel

            return OpenAIModel(
                model_id=_mantle_endpoint_model_id(model_id), bedrock_mantle_config=mantle_config
            )
    return model_id


def _agent_overrides() -> dict:
    """strandsharness knob overrides for this run, or ``{}``.

    ``STRANDSHARNESS_AGENT_CONFIG`` is a JSON object of ``create_harness`` kwargs (``effort``,
    ``context_manager``, ``memory``, ``builtin_tools``, ``builtin_plugins``, ``model`` ...).
    The runner forwards it base64-encoded as ``STRANDSHARNESS_AGENT_CONFIG_B64`` because agent env
    travels through ``--ae K=V`` argv, where JSON quoting would not survive. Either name works
    here. This is how the co-design grid moves strandsharness's defaults one knob at a time
    (bayesbench_sessions/FACTORS.md); without it every knob runs at strandsharness's default.
    """
    raw = os.environ.get("STRANDSHARNESS_AGENT_CONFIG")
    if not raw and os.environ.get("STRANDSHARNESS_AGENT_CONFIG_B64"):
        raw = base64.b64decode(os.environ["STRANDSHARNESS_AGENT_CONFIG_B64"]).decode()
    if not raw:
        return {}
    overrides = json.loads(raw)
    if not isinstance(overrides, dict):
        raise ValueError("STRANDSHARNESS_AGENT_CONFIG must be a JSON object of create_harness kwargs")
    return overrides


def _model_string() -> str | None:
    """``STRANDS_MODEL`` as the ``provider/name`` string strandsharness resolves itself.

    Used only under ``STRANDSHARNESS_AGENT_CONFIG``. A pre-built Model instance (what ``_resolve_model``
    returns for Mantle GPT) makes ``create_harness`` ignore ``effort``, so the effort knob
    would silently no-op. Passing the string lets strandsharness resolve the model AND apply effort.
    """
    model_id = os.environ.get("STRANDS_MODEL")
    if not model_id:
        return None
    if "/" in model_id:
        return model_id
    if not model_id.startswith(_MANTLE_ROUTE_PREFIX):
        return model_id
    return f"bedrock-mantle/{_mantle_endpoint_model_id(model_id)}"


def _on_mantle_anthropic_endpoint() -> bool:
    return _MANTLE_HOST in os.environ.get("ANTHROPIC_BASE_URL", "")


def _tool_executor():
    """Sequential dispatch when the benchmark's evaluator reads the transcript back.

    strandsharness defaults to ConcurrentToolExecutor. On TAU3 that races the runtime server's
    unlocked append/execute/append and splits an assistant/tool pair, which tau2 cannot
    score (#178). run-benchmark.sh sets the flag only for TAU3.
    """
    if not os.environ.get("STRANDSHARNESS_SEQUENTIAL_TOOLS"):
        return None
    return SequentialToolExecutor()


def _mcp_tools() -> list:
    """Load Harbor-declared MCP servers into MCPClient instances, verifying each surfaces tools.

    Fail-loud contract: if ``HARBOR_MCP_SERVERS`` is set for a benchmark, the trial refuses to
    launch when a configured server connects but exposes zero tools. Strands' ``MCPClient`` swallows
    connect failures and returns an empty tool list when ``continue_on_error=True`` and only warns;
    even under the default (raise on connect fail), a server that connects successfully but
    surfaces no tools would still silently produce an agent with none of the MCP tools it was
    supposed to have. The agent then falls back to whatever built-in tools it has (``shell``,
    ``read``, ...) and the benchmark measures a fundamentally different capability than intended.
    A single silent occurrence of this — see strands-agents/stan#9 — invalidated a full-source
    calibration run. The guard here makes that class of failure loud on the first trial.
    """
    # Set only by this fork's own Strands adapter (strands-legacy). On upstream's (strands,
    # what the runner launches), Harbor's runner connects the servers after create_agent()
    # and makes the same check (require_mcp_tools), so this returns no clients there.
    raw_servers = os.environ.get("HARBOR_MCP_SERVERS")
    if not raw_servers:
        return []

    from mcp import StdioServerParameters, stdio_client
    from mcp.client.sse import sse_client
    try:
        from mcp.client.streamable_http import streamablehttp_client
    except ImportError:  # mcp >= 2 renamed it; stan main (#72, strands-agents >= 1.55) pulls mcp 2.x
        from mcp.client.streamable_http import streamable_http_client as streamablehttp_client
    from strands.tools.mcp import MCPClient

    clients = []
    for server in json.loads(raw_servers):
        transport = server["transport"]
        name = server.get("name") or "<unnamed>"
        if transport == "stdio":
            parameters = StdioServerParameters(
                command=server["command"],
                args=server.get("args", []),
            )
            transport_factory = partial(stdio_client, parameters)
        elif transport == "sse":
            url = server["url"]
            transport_factory = partial(sse_client, url)
        elif transport == "streamable-http":
            url = server["url"]
            transport_factory = partial(streamablehttp_client, url=url)
        else:
            raise ValueError(f"Unsupported MCP transport: {transport}")
        client = MCPClient(transport_factory)
        # Connect here (not lazily inside Agent.load_tools) so a connect failure raises
        # immediately at this call site with the server name attached, instead of getting
        # swallowed by MCPClient's continue_on_error path or bubbling up as a generic
        # ToolProviderException at agent-init time.
        client.start()
        listed = client.list_tools_sync()
        if not listed:
            client.stop(None, None, None)
            raise RuntimeError(
                f"MCP server {name!r} ({transport}) connected but reported zero tools. "
                f"Refusing to launch: the model would see none of the MCP tools it was "
                f"configured with and silently fall back to built-in tools, changing what "
                f"the benchmark actually measures. Verify the server's tool exposure."
            )
        # Strands' ``Agent.load_tools`` re-invokes ``start()`` unless the provider records
        # having been started. Pre-mark to skip that call — we already own the session and
        # its lifecycle now.
        client._tool_provider_started = True
        clients.append(client)
    return clients


class MyAgent:
    def create_agent(self) -> Agent:
        task_workdir = os.environ.get("HARBOR_TASK_WORKDIR")
        if task_workdir:
            os.chdir(task_workdir)
        overrides = _agent_overrides()
        # Harbor's --effort, which its Strands adapter passes as HARBOR_REASONING_EFFORT: the
        # harness's effort, over a config's (run-benchmark.sh sets effort high for GPT-5.6).
        if os.environ.get("HARBOR_REASONING_EFFORT"):
            overrides["effort"] = os.environ["HARBOR_REASONING_EFFORT"]
        model = overrides.pop("model", None) or (_model_string() if overrides else _resolve_model())
        executor = _tool_executor()
        trellis = load_trellis(os.path.dirname(os.path.abspath(__file__)))
        instructions = "\n\n".join(
            part for part in (_task_instructions(task_workdir), trellis.announcement()) if part
        ) or None
        kwargs = {
            "model": model,
            **({"tool_executor": executor} if executor is not None else {}),
            **({"builtin_tools": dict(_MANTLE_ANTHROPIC_BUILTIN_TOOLS)} if _on_mantle_anthropic_endpoint() else {}),
            "instructions": instructions,
            "tools": _mcp_tools(),
            **({"hooks": [TrellisHook(trellis)]} if trellis.enforce and trellis.rules else {}),
        }
        # Knob overrides win over the derived defaults above, except the MCP tools the
        # benchmark declares and the task instructions, which are the benchmark's, not the knob's.
        overrides.pop("tools", None)
        overrides.pop("instructions", None)
        kwargs.update(overrides)
        return create_harness(**kwargs)
