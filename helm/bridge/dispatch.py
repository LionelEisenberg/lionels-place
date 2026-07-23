"""Resolve which provider runs a job (capability routing + fallback chain) and execute it."""

import os

import claude_exec
import gemini_exec

# Providers that can accept image input.
_VISION = {"gemini"}


def _run_claude(job: dict) -> dict:
    p = job["request_payload"]
    return claude_exec.run_claude(
        system_prompt=p.get("system_prompt", ""), prompt=p.get("prompt", ""),
        want_json=p.get("want_json", False), effort=job.get("effort"), model=job.get("model"),
    )


def _run_gemini(job: dict) -> dict:
    p = job["request_payload"]
    return gemini_exec.run_gemini(
        task_type=job.get("task_type", "chat"), system_prompt=p.get("system_prompt", ""),
        prompt=p.get("prompt", ""), want_json=p.get("want_json", False),
        image_base64=p.get("image_base64"), model=job.get("model"),
    )


_RUNNERS = {"claude": "_run_claude", "gemini": "_run_gemini"}


def _provider_chain(job: dict) -> list[str]:
    """Ordered providers to try. Image jobs route to vision-capable providers only."""
    has_image = bool(job["request_payload"].get("image_base64"))
    primary = (job.get("provider") or os.getenv("LLM_PROVIDER", "claude")).lower()
    fallback = [p.strip().lower() for p in os.getenv("LLM_FALLBACK", "").split(",") if p.strip()]
    chain = []
    for name in [primary, *fallback]:
        if name in _RUNNERS and name not in chain:
            chain.append(name)
    if has_image:
        vision = [n for n in chain if n in _VISION]
        return vision or [n for n in _RUNNERS if n in _VISION]
    return chain or ["claude"]


def run_job(job: dict) -> dict:
    """Execute a claimed job. Returns a normalized result dict (has "error" if all providers failed)."""
    last = {"text": "", "error": "no provider available"}
    for name in _provider_chain(job):
        runner = globals()[_RUNNERS[name]]
        result = runner(job)
        if not result.get("error"):
            result.setdefault("provider", name)
            return result
        last = result
    return last
