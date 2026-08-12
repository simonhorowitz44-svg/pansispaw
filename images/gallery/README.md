# Gallery photos

Drop new photos in this folder to appear on the website gallery.

## Quick method (recommended)

1. Save your photo here (jpg / png / webp). Use a simple filename like `pansi-zoomies.jpg`.
2. Open Terminal and run:
   ```
   cd /Users/simonhorowitz/Documents/course-materials/my-website
   python3 images/gallery/regenerate.py
   ```
3. Commit and push:
   ```
   git add images/gallery/
   git commit -m "Add gallery photos"
   git push origin main
   ```
4. Photo appears on the homepage gallery within ~1 minute.

## Manual method (if you prefer)

If you don't want to run the script, just edit `photos.json` by hand:

1. Drop your photo in this folder.
2. Open `photos.json`.
3. Add a line like: `{ "file": "your-photo.jpg", "alt": "Pansi playing in the yard" }`
4. Commit + push.

## Tips

- **Best size:** photos around 1200 × 1200 px look great. Larger is fine but slower to load.
- **Square photos** crop best in the grid layout. Portrait/landscape will be centre-cropped to square thumbnails.
- **File names:** lowercase, hyphens, no spaces or special characters.
- **Order:** photos appear in the order listed in `photos.json` (top of list = top-left of grid).
- To **remove** a photo from the website: delete the line in `photos.json` (you don't have to delete the file from the folder).
- To **reorder**: rearrange the lines in `photos.json`.

## Don't include

- Photos of clients' dogs without their permission
- Photos that identify the home's location
- Anything not on-brand (we want calm, warm, dog-focused)
