import os
import sqlite3
from collections import defaultdict
import re

# Resolve the database path
# Assumes script is in /scripts/ and db is in /data/
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, "data", "fitness.db")

def normalize_name(name):
    """
    Apply basic normalization to a name to help group similar ones.
    """
    # Convert to lowercase
    n = name.lower()
    
    # Standardize common variations before alphanumeric cleaning
    n = n.replace("pull up", "pull-up")
    n = n.replace("pullup", "pull-up")
    
    # Replace common abbreviations
    # Use word boundaries to avoid replacing parts of words (e.g., 'dubbell' vs 'db')
    n = re.sub(r'\bdb\b', 'dumbbell', n)
    n = re.sub(r'\bbb\b', 'barbell', n)
    
    # Remove punctuation except hyphens (useful for pull-up)
    n = re.sub(r'[^\w\s\-]', '', n)
    
    # Remove extra whitespace
    n = " ".join(n.split())
    
    # Handle plural (very basic) - only strip 's' if it's not 'ss' or 'us'
    if n.endswith('s') and not (n.endswith('ss') or n.endswith('us')):
        # Check against common exercises ending in s that shouldn't be stripped
        # (e.g., 'leg press' is handled by 'ss' check, but maybe others)
        n = n[:-1]
    
    return n

def get_exercise_counts(cursor):
    cursor.execute("SELECT exercise, COUNT(*) FROM workouts GROUP BY exercise")
    return {row[0]: row[1] for row in cursor.fetchall()}

def main():
    if not os.path.exists(DB_PATH):
        print(f"Error: Database not found at {DB_PATH}")
        return

    print(f"--- Exercise Name Normalizer ---")
    print(f"Database: {DB_PATH}")
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # 1. Fetch counts for each exercise to show impact
    exercise_counts = get_exercise_counts(cursor)
    raw_names = list(exercise_counts.keys())

    if not raw_names:
        print("No exercises found in the database.")
        conn.close()
        return

    print(f"Found {len(raw_names)} unique exercise names in the database.")

    # 2. Group names by normalized version
    groups = defaultdict(list)
    for name in raw_names:
        norm = normalize_name(name)
        groups[norm].append(name)

    # 3. Filter for groups that actually need merging (more than 1 variation)
    merge_candidates = {k: v for k, v in groups.items() if len(v) > 1}

    if not merge_candidates:
        print("\nNo obvious merge candidates found by the normalization algorithm.")
        print("Everything looks consistent!")
    else:
        print(f"\nFound {len(merge_candidates)} groups of exercises that likely refer to the same thing:")

        for norm_key, variations in merge_candidates.items():
            print(f"\n------------------------------------------------")
            print(f"Potential Group: {norm_key.upper()}")
            
            # Sort variations by count descending to suggest best candidate
            sorted_vars = sorted(variations, key=lambda x: exercise_counts.get(x, 0), reverse=True)
            
            for i, v in enumerate(sorted_vars):
                count = exercise_counts.get(v, 0)
                print(f"  {i+1}. {v} ({count} entries)")
            
            print(f"  {len(sorted_vars)+1}. Enter Custom Name")
            print(f"  {len(sorted_vars)+2}. SKIP / Keep separate")

            while True:
                choice = input(f"\nSelect target name (1-{len(sorted_vars)+2}): ").strip()
                if not choice:
                    print("Please make a selection.")
                    continue
                
                if not choice.isdigit():
                    print("Invalid input. Please enter a number.")
                    continue
                
                idx = int(choice)
                if idx == len(sorted_vars) + 2:
                    print("Skipping this group.")
                    break
                
                if idx == len(sorted_vars) + 1:
                    canonical_name = input("Enter custom name: ").strip()
                    if not canonical_name:
                        print("Invalid name. Skipping...")
                        break
                elif 1 <= idx <= len(sorted_vars):
                    canonical_name = sorted_vars[idx-1]
                else:
                    print("Invalid choice.")
                    continue

                # Confirmation
                confirm = input(f"Merge all variations into '{canonical_name}'? (y/n): ").strip().lower()
                if confirm == 'y':
                    print(f"Updating database...")
                    for var in sorted_vars:
                        if var == canonical_name:
                            continue
                        cursor.execute("UPDATE workouts SET exercise = ? WHERE exercise = ?", (canonical_name, var))
                    conn.commit()
                    print("Success!")
                else:
                    print("Merge cancelled.")
                break

    conn.close()
    print("\n--- Process complete ---")

if __name__ == "__main__":
    main()
