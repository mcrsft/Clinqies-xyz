#!/usr/bin/env python3
"""
clinqies admin tools
Usage:
  python3 admin.py create-invite [--count N] [--expires-days N]
  python3 admin.py list-users
  python3 admin.py list-invites
  python3 admin.py storage-report
  python3 admin.py set-admin <username>
  python3 admin.py delete-user <username>
  python3 admin.py clean-orphans   # delete files on disk not in DB
"""

import sqlite3
import sys
import os
import secrets
import time
from pathlib import Path
from datetime import datetime, timezone

DB_PATH = os.environ.get('DB_PATH', '/var/www/clinqies/data/clinqies.db')
UPLOAD_DIR = os.environ.get('UPLOAD_DIR', '/var/www/clinqies/uploads')

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

def fmt_size(b):
    for unit in ['B','KB','MB','GB','TB']:
        if b < 1024:
            return f"{b:.1f} {unit}" if unit != 'B' else f"{b} B"
        b /= 1024
    return f"{b:.1f} PB"

def fmt_ts(ts):
    if not ts:
        return 'never'
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime('%Y-%m-%d %H:%M UTC')

# ── COMMANDS ──

def create_invite(count=1, expires_days=None):
    db = get_db()
    expires_at = int(time.time()) + expires_days * 86400 if expires_days else None
    codes = []
    for _ in range(count):
        code = secrets.token_urlsafe(12)
        db.execute("INSERT INTO invites (code, expires_at) VALUES (?, ?)", (code, expires_at))
        codes.append(code)
    db.commit()
    print(f"Generated {count} invite code(s):")
    for c in codes:
        print(f"  {c}")
    if expires_at:
        print(f"  Expires: {fmt_ts(expires_at)}")
    else:
        print(f"  Expires: never")

def list_users():
    db = get_db()
    rows = db.execute("""
        SELECT u.username, u.email, u.role, u.storage_used,
               COUNT(f.id) as files, u.created_at, u.last_seen
        FROM users u
        LEFT JOIN files f ON f.user_id = u.id AND f.deleted = 0
        GROUP BY u.id
        ORDER BY u.created_at DESC
    """).fetchall()
    print(f"{'username':<20} {'email':<30} {'role':<8} {'files':>6} {'storage':>10} {'created':<20} {'last seen'}")
    print('-' * 110)
    for r in rows:
        print(f"{r['username']:<20} {r['email']:<30} {r['role']:<8} {r['files']:>6} {fmt_size(r['storage_used'] or 0):>10} {fmt_ts(r['created_at']):<20} {fmt_ts(r['last_seen'])}")

def list_invites():
    db = get_db()
    rows = db.execute("""
        SELECT i.code, i.created_at, i.expires_at, i.used_at,
               u1.username as created_by, u2.username as used_by
        FROM invites i
        LEFT JOIN users u1 ON u1.id = i.created_by
        LEFT JOIN users u2 ON u2.id = i.used_by
        ORDER BY i.created_at DESC
    """).fetchall()
    print(f"{'code':<20} {'created by':<15} {'used by':<15} {'expires':<22} {'used at'}")
    print('-' * 100)
    for r in rows:
        used = r['used_by'] or '—'
        created = r['created_by'] or 'system'
        print(f"{r['code']:<20} {created:<15} {used:<15} {fmt_ts(r['expires_at']):<22} {fmt_ts(r['used_at'])}")

def storage_report():
    db = get_db()
    total = db.execute("SELECT COALESCE(SUM(size),0) as t FROM files WHERE deleted=0").fetchone()['t']
    by_user = db.execute("""
        SELECT u.username, COUNT(f.id) as files, COALESCE(SUM(f.size),0) as sz
        FROM users u
        LEFT JOIN files f ON f.user_id = u.id AND f.deleted=0
        GROUP BY u.id
        ORDER BY sz DESC
    """).fetchall()

    disk_total = sum(p.stat().st_size for p in Path(UPLOAD_DIR).iterdir() if p.is_file()) if Path(UPLOAD_DIR).exists() else 0

    print(f"=== clinqies.xyz storage report ===")
    print(f"DB tracked:  {fmt_size(total)}")
    print(f"Disk actual: {fmt_size(disk_total)}")
    print(f"Quota:       1 TB  ({total/1099511627776*100:.2f}% used)")
    print()
    print(f"{'username':<20} {'files':>8} {'size':>12}")
    print('-' * 44)
    for r in by_user:
        print(f"{r['username']:<20} {r['files']:>8} {fmt_size(r['sz']):>12}")

def set_admin(username):
    db = get_db()
    cur = db.execute("UPDATE users SET role='admin' WHERE username=?", (username,))
    db.commit()
    if cur.rowcount:
        print(f"Set {username} as admin")
    else:
        print(f"User not found: {username}")

def delete_user(username):
    db = get_db()
    user = db.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
    if not user:
        print(f"User not found: {username}")
        return
    confirm = input(f"Delete user '{username}' and ALL their files? [yes/no]: ")
    if confirm.lower() != 'yes':
        print("Aborted")
        return
    db.execute("DELETE FROM users WHERE id=?", (user['id'],))
    db.commit()
    print(f"Deleted user {username}")

def clean_orphans():
    db = get_db()
    db_files = {r['filename'] for r in db.execute("SELECT filename FROM files WHERE deleted=0").fetchall()}
    upload_path = Path(UPLOAD_DIR)
    if not upload_path.exists():
        print("Upload dir not found")
        return
    removed = 0
    freed = 0
    for f in upload_path.iterdir():
        if f.is_file() and f.name not in db_files:
            size = f.stat().st_size
            print(f"  orphan: {f.name} ({fmt_size(size)})")
            f.unlink()
            removed += 1
            freed += size
    print(f"Removed {removed} orphan file(s), freed {fmt_size(freed)}")

# ── MAIN ──
if __name__ == '__main__':
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(0)

    cmd = args[0]
    if cmd == 'create-invite':
        count = int(args[args.index('--count') + 1]) if '--count' in args else 1
        days = int(args[args.index('--expires-days') + 1]) if '--expires-days' in args else None
        create_invite(count, days)
    elif cmd == 'list-users':
        list_users()
    elif cmd == 'list-invites':
        list_invites()
    elif cmd == 'storage-report':
        storage_report()
    elif cmd == 'set-admin':
        set_admin(args[1])
    elif cmd == 'delete-user':
        delete_user(args[1])
    elif cmd == 'clean-orphans':
        clean_orphans()
    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)
