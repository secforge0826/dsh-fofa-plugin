# DSH FOFA Plugin

DSH plugin for network asset collection using FOFA and other platforms.

This repository contains a FOFA integration plugin for DSH. See plugins/fofa.py for the implementation and usage.

Usage

1. Set FOFA credentials as environment variables:

```bash
export FOFA_EMAIL="your_fofa_email"
export FOFA_KEY="your_fofa_api_key"
```

2. Install requirements:

```bash
pip install -r requirements.txt
```

3. Run the FOFA collector from the repo root (example):

```bash
python -m plugins.fofa -q "app=nginx" -o assets.jsonl --pages 2
```

The collector will write JSON Lines (one JSON object per line) to the output file.
