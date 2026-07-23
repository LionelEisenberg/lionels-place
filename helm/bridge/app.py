"""
Claude Code Bridge — lightweight proxy between Helm (Docker) and Claude Code CLI.
Runs on the host machine where Claude Code is installed and authenticated.
"""

import json
import logging

from fastapi import FastAPI
from pydantic import BaseModel

from claude_exec import strip_code_fences, _query_claude

logger = logging.getLogger(__name__)

app = FastAPI(title="Claude Code Bridge")


class GenerateRequest(BaseModel):
    system_prompt: str
    prompt: str
    want_json: bool = False
    effort: str | None = None
    model: str | None = None


class GenerateResponse(BaseModel):
    text: str
    error: str | None = None
    model: str | None = None
    effort: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    total_cost_usd: float = 0.0


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/generate", response_model=GenerateResponse)
async def generate(req: GenerateRequest):
    prompt = req.prompt
    if req.want_json:
        prompt += "\n\nRespond with ONLY valid JSON. No markdown, no explanation, no code fences."

    result = await _query_claude(req.system_prompt, prompt, effort=req.effort, model=req.model)

    if result["error"]:
        return GenerateResponse(text="", error=result["error"])

    if result["text"] is None:
        return GenerateResponse(text="", error="No response from Claude")

    text = result["text"]

    # JSON validation and retry
    if req.want_json:
        text = strip_code_fences(text)
        try:
            json.loads(text)
        except json.JSONDecodeError:
            # Retry once with stricter prompt
            strict_prompt = (
                "Your previous response was not valid JSON. "
                "Respond with ONLY a valid JSON object. "
                "No text before or after. No markdown.\n\n" + req.prompt
            )
            retry = await _query_claude(req.system_prompt, strict_prompt, effort=req.effort, model=req.model)
            if retry["text"]:
                retry_text = strip_code_fences(retry["text"])
                try:
                    json.loads(retry_text)
                    text = retry_text
                    # Update usage to include retry tokens
                    result["input_tokens"] += retry["input_tokens"]
                    result["output_tokens"] += retry["output_tokens"]
                    result["cache_read_tokens"] += retry["cache_read_tokens"]
                    result["cache_creation_tokens"] += retry["cache_creation_tokens"]
                    result["total_cost_usd"] += retry["total_cost_usd"]
                except json.JSONDecodeError:
                    return GenerateResponse(text="", error="JSON parse failed after retry")
            else:
                return GenerateResponse(text="", error="No response on JSON retry")

    return GenerateResponse(
        text=text,
        model=result["model"],
        effort=result["effort"],
        input_tokens=result["input_tokens"],
        output_tokens=result["output_tokens"],
        cache_read_tokens=result["cache_read_tokens"],
        cache_creation_tokens=result["cache_creation_tokens"],
        total_cost_usd=result["total_cost_usd"],
    )
