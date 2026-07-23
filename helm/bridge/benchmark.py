"""
Benchmark: replay past Claude queries through Haiku and Sonnet, compare with original Opus results.
Run inside the claude-bridge container with DB mounted.
"""

import asyncio
import json
import sqlite3
import time
import sys

from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage

MODELS = ["claude-haiku-4-5", "claude-sonnet-4-6"]
DB_PATH = "/app/data/fitness.db"


async def run_query(system_prompt: str, prompt: str, model: str, effort: str = "low") -> dict:
    """Run a single query and return results."""
    start = time.time()
    result = {"text": None, "model": model, "input_tokens": 0, "output_tokens": 0, "cost": 0.0}

    try:
        async for msg in query(
            prompt=prompt,
            options=ClaudeAgentOptions(
                system_prompt=system_prompt,
                max_turns=1,
                allowed_tools=[],
                model=model,
                effort=effort,
            )
        ):
            if isinstance(msg, ResultMessage):
                result["text"] = msg.result
                result["cost"] = msg.total_cost_usd or 0.0
                if msg.model_usage:
                    for mid, usage in msg.model_usage.items():
                        result["model"] = mid
                        result["input_tokens"] = (
                            usage.get("inputTokens", 0)
                            + usage.get("cacheReadInputTokens", 0)
                            + usage.get("cacheCreationInputTokens", 0)
                        )
                        result["output_tokens"] = usage.get("outputTokens", 0)
    except Exception as e:
        result["error"] = str(e)

    result["latency_ms"] = int((time.time() - start) * 1000)
    return result


async def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    rows = conn.execute("""
        SELECT id, task_type, input_text, output_text, prompt_tokens, response_tokens,
               total_tokens, latency_ms, effort, estimated_cost
        FROM gemini_request_log
        WHERE provider = 'claude' AND error IS NULL
        ORDER BY id
    """).fetchall()

    print(f"\n{'='*100}")
    print(f"BENCHMARK: Replaying {len(rows)} Opus queries through Haiku and Sonnet")
    print(f"{'='*100}\n")

    totals = {
        "opus": {"tokens": 0, "latency": 0, "cost": 0.0, "count": 0},
        "claude-haiku-4-5": {"tokens": 0, "latency": 0, "cost": 0.0, "count": 0},
        "claude-sonnet-4-6": {"tokens": 0, "latency": 0, "cost": 0.0, "count": 0},
    }

    for i, row in enumerate(rows):
        task = row["task_type"]
        opus_tokens = row["total_tokens"] or 0
        opus_latency = row["latency_ms"] or 0
        opus_cost = row["estimated_cost"] or 0.0
        opus_output = row["output_text"] or ""
        prompt = row["input_text"] or ""

        if not prompt.strip():
            continue

        print(f"--- Query {i+1}/{len(rows)}: id={row['id']} task={task} ---")
        print(f"  OPUS (original): {opus_tokens} tokens, {opus_latency}ms, ${opus_cost:.4f}, {len(opus_output)} chars output")

        totals["opus"]["tokens"] += opus_tokens
        totals["opus"]["latency"] += opus_latency
        totals["opus"]["cost"] += opus_cost
        totals["opus"]["count"] += 1

        for model in MODELS:
            result = await run_query(
                system_prompt="Follow the instructions in the prompt exactly.",
                prompt=prompt,
                model=model,
                effort="low",
            )

            if result.get("error"):
                print(f"  {model}: ERROR — {result['error']}")
                continue

            total_tok = result["input_tokens"] + result["output_tokens"]
            output_len = len(result["text"] or "")

            # Check JSON validity if original was JSON
            json_ok = "-"
            if opus_output.strip().startswith("{") or opus_output.strip().startswith("["):
                try:
                    json.loads(result["text"])
                    json_ok = "valid"
                except (json.JSONDecodeError, TypeError):
                    json_ok = "INVALID"

            print(f"  {model}: {total_tok} tokens, {result['latency_ms']}ms, ${result['cost']:.4f}, {output_len} chars output, json={json_ok}")

            totals[model]["tokens"] += total_tok
            totals[model]["latency"] += result["latency_ms"]
            totals[model]["cost"] += result["cost"]
            totals[model]["count"] += 1

        print()

    # Summary
    print(f"\n{'='*100}")
    print("SUMMARY")
    print(f"{'='*100}")
    print(f"\n{'Model':<30} {'Queries':<10} {'Total Tokens':<15} {'Avg Latency':<15} {'Total Cost':<12} {'Avg Tok/Query':<15}")
    print("-" * 97)
    for name, t in totals.items():
        if t["count"] == 0:
            continue
        avg_lat = t["latency"] // t["count"]
        avg_tok = t["tokens"] // t["count"]
        print(f"{name:<30} {t['count']:<10} {t['tokens']:<15} {avg_lat}ms{'':<9} ${t['cost']:<11.4f} {avg_tok:<15}")

    # Relative comparison
    opus = totals["opus"]
    if opus["count"] > 0:
        print(f"\n{'Model':<30} {'Tokens vs Opus':<18} {'Latency vs Opus':<18} {'Cost vs Opus':<15}")
        print("-" * 81)
        for model in MODELS:
            t = totals[model]
            if t["count"] == 0:
                continue
            tok_pct = (t["tokens"] / opus["tokens"] * 100) if opus["tokens"] else 0
            lat_pct = (t["latency"] / opus["latency"] * 100) if opus["latency"] else 0
            cost_pct = (t["cost"] / opus["cost"] * 100) if opus["cost"] else 0
            print(f"{model:<30} {tok_pct:.0f}%{'':<14} {lat_pct:.0f}%{'':<14} {cost_pct:.0f}%")


if __name__ == "__main__":
    asyncio.run(main())
