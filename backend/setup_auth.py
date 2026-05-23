#!/usr/bin/env python3
"""
Script to initialize auth tables and add admin email to allowlist
"""
import os
import sys
from datetime import datetime

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from db_service import DbService

def main():
    # Initialize database service
    db_path = os.environ.get("DATABASE_PATH", os.path.join(os.path.dirname(__file__), "investments.db"))
    turso_url = os.environ.get("TURSO_DATABASE_URL")
    turso_token = os.environ.get("TURSO_AUTH_TOKEN")
    
    db_service = DbService(db_path, turso_url=turso_url, turso_token=turso_token)
    
    admin_email = "venkatsai.popuri@gmail.com"
    
    try:
        # Add admin email to allowlist
        conn = db_service._connect()
        
        # Check if already exists
        cursor = conn.execute(
            "SELECT 1 FROM allowlist WHERE email = ? LIMIT 1",
            (admin_email,)
        )
        
        if cursor.fetchone() is None:
            conn.execute(
                "INSERT INTO allowlist (email, added_date) VALUES (?, ?)",
                (admin_email, datetime.now().isoformat())
            )
            conn.commit()
            print(f"✅ Added {admin_email} to allowlist")
        else:
            print(f"ℹ️  {admin_email} is already in allowlist")
        
        conn.close()
        
    except Exception as e:
        print(f"❌ Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
