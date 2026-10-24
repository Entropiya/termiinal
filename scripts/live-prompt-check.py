#!/usr/bin/env python3
"""Ручная проверка системного промпта на живом Claude (в CI не запускается: нужен вход в claude и сеть).

    python3 scripts/live-prompt-check.py teach     # режим обучения: основа + src/system-prompt-teaching.md
    python3 scripts/live-prompt-check.py direct    # прямой режим: только src/system-prompt.md
    python3 scripts/live-prompt-check.py teach s4  # полный цикл: вопрос -> «сдаюсь» -> свой запуск

Флаги `claude` те же, что собирает src-tauri/src/agent.rs. Глазами проверяем: в режиме обучения
на первый вопрос нет готовой команды (ступень 1), после «сдаюсь» есть блок bash, на ошибку подсказка
без исправления, на опасное предупреждение, после удачного запуска практика и блок rule.
"""
import json
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = (ROOT / "src/system-prompt.md").read_text()
TEACH = (ROOT / "src/system-prompt-teaching.md").read_text()
CTX = "[Контекст] активная сессия: SSH user@debian. ОС: debian 12."
OUT = "Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        40G   31G  7.2G  82% /"

SCENARIOS = {
    "S1 вопрос в чате, затем «сдаюсь»": [
        f"{CTX}\n\nкак посмотреть сколько свободного места на диске?",
        f"{CTX}\n\nне знаю, сдаюсь, покажи ответ",
    ],
    "S2 блок с ошибкой": [f"{CTX}\n\n[БЛОК] cwd=/home/user exit=127\n$ sl -la\nbash: sl: command not found"],
    "S3 опасное": [f"{CTX}\n\nхочу быстро почистить диск, что-то вроде rm -rf /var/lib/* подойдёт?"],
}
FULL_CYCLE = {
    "S4 вопрос, «сдаюсь», свой запуск": [
        f"{CTX}\n\nкак посмотреть сколько свободного места на диске?",
        f"{CTX}\n\nсдаюсь, покажи ответ",
        f"{CTX}\n\n[БЛОК] cwd=/home/user exit=0\n$ df -h\n{OUT}",
    ]
}


def run(system_prompt, messages, model="claude-haiku-5-5"):
    cmd = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
           "--include-partial-messages", "--replay-user-messages", "--tools", "", "--mcp-config",
           '{"mcpServers":{}}', "--strict-mcp-config", "--disallowedTools", "Task,Edit,Write,NotebookEdit",
           "--permission-prompts", "none", "--system-prompt", system_prompt, "--setting-sources", "",
           "--model", model]
    with tempfile.TemporaryDirectory() as cwd:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                text=True, cwd=cwd)
        results = []
        for m in messages:
            line = {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": m}]}}
            proc.stdin.write(json.dumps(line, ensure_ascii=False) + "\n")
            proc.stdin.flush()
            for raw in proc.stdout:  # реплики по одной, как в приложении: процесс живёт всю сессию
                try:
                    ev = json.loads(raw)
                except ValueError:
                    continue
                if ev.get("type") == "result":
                    results.append(ev["result"])
                    break
        proc.stdin.close()
        proc.wait(timeout=30)
    return results


if __name__ == "__main__":
    style = sys.argv[1] if len(sys.argv) > 1 else "teach"
    prompt = f"{BASE.rstrip()}\n\n{TEACH.strip()}\n" if style == "teach" else BASE
    for name, msgs in (FULL_CYCLE if len(sys.argv) > 2 else SCENARIOS).items():
        print("=" * 20, style, name)
        for i, r in enumerate(run(prompt, msgs), 1):
            print(f"--- ответ {i}:\n{r}\n")
