#!/usr/bin/env python3
import argparse
import subprocess
import tempfile
from pathlib import Path
from typing import Optional


def run_codex_exec(
    prompt: str,
    *,
    model: Optional[str],
    oss: bool,
    local_provider: Optional[str],
    cwd: Path,
) -> str:
    with tempfile.NamedTemporaryFile(prefix="codex_duel_", suffix=".txt", delete=False) as out:
        out_path = Path(out.name)

    cmd: list[str] = ["codex", "exec", "--color", "never", "-o", str(out_path)]
    if model:
        cmd += ["-m", model]
    if oss:
        cmd += ["--oss"]
        if local_provider:
            cmd += ["--local-provider", local_provider]

    # PROMPT は引数にせず stdin で渡す（クォート問題回避）
    subprocess.run(
        cmd + ["-"],
        input=prompt,
        text=True,
        cwd=str(cwd),
        check=True,
    )
    return out_path.read_text(encoding="utf-8", errors="replace").strip()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Codex CLI を2インスタンスとして交互に会話させるリレー（非対話: codex exec）。"
    )
    parser.add_argument("--turns", type=int, default=10, help="往復ターン数（発話回数ではなく往復）")
    parser.add_argument("--seed", type=str, required=True, help="最初の話題/指示（Aに渡されます）")
    parser.add_argument("--a-model", type=str, default=None, help="Agent A のモデル名（省略でデフォルト）")
    parser.add_argument("--b-model", type=str, default=None, help="Agent B のモデル名（省略でデフォルト）")
    parser.add_argument(
        "--oss",
        action="store_true",
        help="ローカルOSSプロバイダを使う（課金回避）。Ollama/LM Studio が起動している必要があります。",
    )
    parser.add_argument("--local-provider", choices=["ollama", "lmstudio"], default=None)
    parser.add_argument(
        "--log",
        type=Path,
        default=Path("codex_duel_transcript.md"),
        help="会話ログ出力先",
    )
    args = parser.parse_args()

    cwd = Path.cwd()
    transcript: list[str] = []

    system_a = "あなたは Agent A です。相手(Agent B)の発言に対して、簡潔に返答してください。"
    system_b = "あなたは Agent B です。相手(Agent A)の発言に対して、簡潔に返答してください。"

    last_b = ""
    for t in range(1, args.turns + 1):
        prompt_a = "\n\n".join(
            [
                system_a,
                f"会話ログ:\n{''.join(transcript) or '(まだなし)'}",
                f"直近の Agent B 発言:\n{last_b or '(まだなし)'}",
                f"今回の話題/指示:\n{args.seed if t == 1 else '(継続)'}",
                "Agent A として次の1発話だけ出力してください。",
            ]
        )
        a = run_codex_exec(
            prompt_a,
            model=args.a_model,
            oss=args.oss,
            local_provider=args.local_provider,
            cwd=cwd,
        )
        transcript.append(f"\n## Turn {t}\n\n### Agent A\n\n{a}\n")

        prompt_b = "\n\n".join(
            [
                system_b,
                f"会話ログ:\n{''.join(transcript)}",
                f"直近の Agent A 発言:\n{a}",
                "Agent B として次の1発話だけ出力してください。",
            ]
        )
        b = run_codex_exec(
            prompt_b,
            model=args.b_model,
            oss=args.oss,
            local_provider=args.local_provider,
            cwd=cwd,
        )
        transcript.append(f"\n### Agent B\n\n{b}\n")
        last_b = b

        args.log.write_text("".join(transcript).lstrip(), encoding="utf-8")
        print(f"[{t}/{args.turns}] wrote {args.log}")


if __name__ == "__main__":
    main()
