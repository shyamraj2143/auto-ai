from pathlib import Path

path = Path("frontend/src/reliability/requestedFeatureFixes.contract.test.ts")
content = path.read_text(encoding="utf-8")
content = content.replace('new URL(`../../${path}`, import.meta.url)', 'new URL(`../${path}`, import.meta.url)')
path.write_text(content, encoding="utf-8")
print("Corrected requested feature contract test paths.")
