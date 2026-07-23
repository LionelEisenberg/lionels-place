"""
Progress photo upload, retrieval, and deletion.
One photo per date, stored in /app/data/photos/ on disk.
"""

import os
import re
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..database import DATA_DIR, get_db
from ..models import ProgressPhoto
from ..schemas import ProgressPhotoResponse

router = APIRouter(prefix="/api/photos", tags=["photos"])

PHOTOS_DIR = Path(DATA_DIR) / "photos"
PHOTOS_DIR.mkdir(exist_ok=True)

ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _validate_date(date: str) -> None:
    if not DATE_PATTERN.match(date):
        raise HTTPException(status_code=400, detail="Invalid date format. Expected YYYY-MM-DD")


@router.post("/upload", response_model=ProgressPhotoResponse)
async def upload_photo(
    date: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    _validate_date(date)
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Allowed types: jpg, jpeg, png, webp")

    filename = f"{date}{ext}"
    file_path = PHOTOS_DIR / filename

    content = await file.read()
    with open(file_path, "wb") as f:
        f.write(content)

    existing = db.query(ProgressPhoto).filter(ProgressPhoto.date == date).first()
    if existing:
        # Remove old file if extension changed
        old_path = PHOTOS_DIR / existing.filename
        if existing.filename != filename and old_path.exists():
            old_path.unlink()
        existing.filename = filename
        db.commit()
        db.refresh(existing)
        return existing

    photo = ProgressPhoto(date=date, filename=filename)
    db.add(photo)
    db.commit()
    db.refresh(photo)
    return photo


@router.get("", response_model=list[ProgressPhotoResponse])
def list_photos(db: Session = Depends(get_db)):
    return db.query(ProgressPhoto).order_by(ProgressPhoto.date.desc()).all()


@router.get("/{date}/image")
def get_photo(date: str, db: Session = Depends(get_db)):
    _validate_date(date)
    photo = db.query(ProgressPhoto).filter(ProgressPhoto.date == date).first()
    if not photo:
        raise HTTPException(status_code=404, detail="Photo not found")
    file_path = PHOTOS_DIR / photo.filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Photo file missing from disk")
    return FileResponse(str(file_path))


@router.delete("/{date}")
def delete_photo(date: str, db: Session = Depends(get_db)):
    _validate_date(date)
    photo = db.query(ProgressPhoto).filter(ProgressPhoto.date == date).first()
    if not photo:
        raise HTTPException(status_code=404, detail="Photo not found")
    file_path = PHOTOS_DIR / photo.filename
    if file_path.exists():
        file_path.unlink()
    db.delete(photo)
    db.commit()
    return {"ok": True}
