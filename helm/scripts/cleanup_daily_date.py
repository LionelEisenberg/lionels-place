import os
import sys

# Add backend directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.database import SessionLocal, engine
from backend.models import DailySummary, Base

Base.metadata.create_all(bind=engine)

db = SessionLocal()
bad_dates = db.query(DailySummary).filter(DailySummary.date == '03/09/26').all()
print('Bad dates found:', len(bad_dates))
for d in bad_dates:
    print('Deleting:', d.id, d.date)
    db.delete(d)
db.commit()
