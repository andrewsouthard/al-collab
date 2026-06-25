# Hermes Agent Backup & Disaster Recovery Plan

## Goal

Ensure full recoverability of a Hermes Agent setup (configuration, skills, cron jobs, memory, scripts) after data loss, machine migration, or catastrophic failure.

## What to Backup

### 1. `~/.hermes/` directory

This is the core. Contains everything Hermes needs to function.

| Path | What it holds |
|---|---|
| `config.yaml` | Agent settings: models, providers, tool configs |
| `skills/` | Custom and curated skill definitions |
| `cron/` | Scheduled job definitions |
| `persistent/` | Persistent agent memory and user profile |
| `plugins/` | Installed plugin configurations |
| `profiles/` | Multi-profile agent configurations |
| `cron/output/` | Historical cron execution output |

### 2. Environment secrets

Provider API keys and secrets set in:
- `~/.bashrc` / `~/.zshrc` (exported `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.)
- `.env` files in the home directory
- Any Hermes-specific secret storage

> **Note:** Don't commit plain-text secrets. Use a password manager or note which keys exist so they can be re-created.

### 3. Custom scripts

Scripts referenced by cron jobs or skills that live outside `~/.hermes/`:
- `~/generate_rss.py` (or similar)
- Any custom automation scripts

### 4. Git-based backup (recommended)

Initialize a private git repository inside `~/.hermes/`:

```bash
cd ~/.hermes
git init
git remote add origin git@github.com:andrewsouthard/hermes-config.git
```

**Benefits:**
- Full change history
- Offsite backup via GitHub
- `git diff` to diagnose when something broke

### 5. Periodic tarball snapshot

For air-gapped or extra-paranoid backup:

```bash
tar czf ~/backups/hermes-$(date +%Y%m%d).tar.gz -C ~ .hermes/
```

Schedule via cron or systemd timer.

## Restore Procedure

1. Install Hermes Agent (see [docs](https://hermes-agent.nousresearch.com/docs))
2. Restore `~/.hermes/` from git clone or tarball
3. Re-set environment secrets for providers
4. Re-install any CLI tools your config depends on (gh, vt, etc.)
5. Verify with:
   ```bash
   hermes tools
   hermes cron list
   ```
6. Run a manual cron job to confirm end-to-end function

## Cost Estimate

- **Time:** ~2 hours initial setup, ~15 min/year thereafter
- **Money:** Free (assuming existing GitHub account)
- **Storage:** < 50MB typically

## Status

- [ ] To be populated with per-environment specifics once reviewed
