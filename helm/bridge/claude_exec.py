"""Claude execution via claude-agent-sdk. Shared by the bridge /generate endpoint
and the queue worker."""

import asyncio
import json
import os
import re

from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage

CLAUDE_EFFORT = os.getenv("CLAUDE_EFFORT", "high")
MAX_RETRIES = int(os.getenv("CLAUDE_MAX_RETRIES", "1"))
# Claude Code is agentic — action/marker-framed prompts (the task/company/etc.
# chats that emit [CREATE_TASK]-style markers) can need >1 turn to reach a final
# answer; max_turns=1 makes them error with "Reached maximum number of turns (1)".
# The worker uses no tools, so a small ceiling is safe.
MAX_TURNS = int(os.getenv("CLAUDE_MAX_TURNS", "8"))


def strip_code_fences(text: str) -> str:
    stripped = re.sub(r'^```(?:json)?\s*\n?', '', text.strip())
    stripped = re.sub(r'\n?```\s*$', '', stripped)
    return stripped.strip()


async def _query_claude_once(system_prompt, prompt, effort=None, model=None) -> dict:
    resolved_effort = effort or CLAUDE_EFFORT
    stderr_lines: list[str] = []
    opts = ClaudeAgentOptions(
        system_prompt=system_prompt, max_turns=MAX_TURNS, allowed_tools=[],
        effort=resolved_effort, stderr=lambda line: stderr_lines.append(line),
    )
    if model:
        opts.model = model
    result = {"text": None, "model": None, "effort": resolved_effort,
              "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0,
              "cache_creation_tokens": 0, "total_cost_usd": 0.0, "error": None}
    try:
        async for message in query(prompt=prompt, options=opts):
            if isinstance(message, ResultMessage):
                result["text"] = message.result
                result["total_cost_usd"] = message.total_cost_usd or 0.0
                if message.model_usage:
                    for model_id, usage in message.model_usage.items():
                        result["input_tokens"] += usage.get("inputTokens", 0)
                        result["cache_read_tokens"] += usage.get("cacheReadInputTokens", 0)
                        result["cache_creation_tokens"] += usage.get("cacheCreationInputTokens", 0)
                        result["output_tokens"] += usage.get("outputTokens", 0)
                    if model and model in message.model_usage:
                        result["model"] = model
                    else:
                        result["model"] = max(message.model_usage.items(),
                                              key=lambda kv: kv[1].get("outputTokens", 0))[0]
    except Exception as e:  # noqa: BLE001
        error_msg = str(e)
        if stderr_lines:
            error_msg = f"{error_msg}\nstderr:\n" + "\n".join(stderr_lines[-20:])
        result["error"] = error_msg
    return result


async def _query_claude(system_prompt, prompt, effort=None, model=None) -> dict:
    result = await _query_claude_once(system_prompt, prompt, effort, model)
    if result["error"] and MAX_RETRIES > 0:
        for _ in range(MAX_RETRIES):
            result = await _query_claude_once(system_prompt, prompt, effort, model)
            if not result["error"]:
                break
    return result


def run_claude(*, system_prompt: str, prompt: str, want_json: bool,
               effort: str | None, model: str | None) -> dict:
    """Sync entry point. Appends a JSON instruction when want_json, strips fences,
    validates JSON (one stricter retry), and returns a normalized result dict."""
    full_prompt = prompt
    if want_json:
        full_prompt += "\n\nRespond with ONLY valid JSON. No markdown, no explanation, no code fences."

    result = asyncio.run(_query_claude(system_prompt, full_prompt, effort, model))
    if result.get("error") or result.get("text") is None:
        return {"text": "", "error": result.get("error") or "No response from Claude"}

    text = result["text"]
    json_valid = None
    if want_json:
        text = strip_code_fences(text)
        try:
            json.loads(text)
            json_valid = True
        except json.JSONDecodeError:
            strict = ("Your previous response was not valid JSON. Respond with ONLY a valid "
                      "JSON object. No text before or after. No markdown.\n\n" + prompt)
            retry = asyncio.run(_query_claude(system_prompt, strict, effort, model))
            if retry.get("text"):
                retry_text = strip_code_fences(retry["text"])
                try:
                    json.loads(retry_text)
                    text, json_valid = retry_text, True
                    for k in ("input_tokens", "output_tokens", "cache_read_tokens",
                              "cache_creation_tokens", "total_cost_usd"):
                        result[k] += retry.get(k, 0)
                except json.JSONDecodeError:
                    return {"text": "", "error": "JSON parse failed after retry"}
            else:
                return {"text": "", "error": "No response on JSON retry"}

    total_input = result["input_tokens"] + result["cache_read_tokens"] + result["cache_creation_tokens"]
    return {
        "text": text, "model": result.get("model") or model, "effort": result.get("effort"),
        "prompt_tokens": total_input, "response_tokens": result["output_tokens"],
        "total_tokens": total_input + result["output_tokens"],
        "estimated_cost": result["total_cost_usd"], "json_valid": json_valid, "error": None,
    }
