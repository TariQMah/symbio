---
name: server-administration
description: Work on servers safely, such as Linux machines, VPSs and cloud instances. Covers looking before changing, backups and rollback, services, logs, disk, users and firewall, and leaving a record. Use when inspecting, configuring, fixing, updating or deploying to a server.
---

# Server administration

A server is someone's production until proven otherwise. Look first, change one thing at a time,
make every change reversible, and write down what you did.

## 1. Look before you touch

- Identify the machine: hostname, OS and version (`cat /etc/os-release`), uptime, who else is
  logged in (`who`), and what it runs (`systemctl list-units --type=service --state=running`,
  listening ports with `ss -tlnp`).
- Check health: disk (`df -h`, and `du -xh --max-depth=1 /var | sort -h` for what's large), memory
  (`free -h`), load (`uptime`, `top -bn1 | head -20`), and recent errors
  (`journalctl -p err -n 50 --no-pager`).
- Read before you change: the config file, the service's unit, the last log lines.
- Prefer read-only commands while you investigate. Say which commands will change things before
  you run them.

## 2. Make changes reversible

- Back up a file before editing it (`cp -a file file.bak-$(date +%F)`), or keep it in version
  control.
- Validate configs before reloading: `nginx -t`, `apachectl configtest`, `sshd -t`,
  `visudo -c`, and `systemd-analyze verify` for units.
- Reload instead of restart when the service supports it. Restart during quiet hours.
- Never change SSH or firewall rules in a way that could lock you out without a second session
  open and a way back (a timed rollback, or console access).
- For anything with data (databases, uploads), confirm a recent, restorable backup exists before
  changing it. A backup nobody has restored is a hope.

## 3. Common work

- **Packages:** update with the distribution's tool. Read what will change first (`apt list
  --upgradable`), and note anything that needs a restart or a reboot.
- **Services:** `systemctl status`, `journalctl -u <service> -n 100`. Enable at boot only what
  should start at boot.
- **Disk full:** find what grew (logs, caches, old releases, core dumps), and fix the cause
  (rotation, retention), not only the symptom.
- **Users and access:** keys over passwords, least privilege, `sudo` with a reason. Remove access
  that's no longer needed.
- **Firewall:** allow only what must be reachable. Write down why each rule exists.
- **Deploys:** keep the previous release so a rollback is one step, and check the service answers
  after deploying (an HTTP check, a health endpoint, the log).

## 4. Secrets

Never print, copy or commit passwords, keys or tokens. Read them from where they're stored, and
don't paste them into reports.

## 5. Leave a record

Write what you found, what you changed (with the exact commands or file diffs), why, how to undo
it, and what to watch afterwards. The next person on this machine, possibly you, needs it.
