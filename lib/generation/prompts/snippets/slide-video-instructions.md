### VideoElement

```json
{
  "id": "video_001",
  "type": "video",
  "left": 100,
  "top": 150,
  "width": 500,
  "height": 281,
  "mediaRef": "gen_vid_1",
  "autoplay": false
}
```

**Required Fields**: `id`, `type`, `left`, `top`, `width`, `height`, `mediaRef` (generated video media ref copied exactly from the assigned media list, e.g. "gen_vid_1"), `autoplay` (boolean)

**Video Sizing Rules**:

- `mediaRef` MUST be copied exactly from a generated video entry in the `mediaGenerations` list (e.g., "gen_vid_1")
- Default aspect ratio: 16:9 → `height = width / 1.778`
- Typical video width: 400-600px (prominent on slide)
- Position video as a focal element — usually centered or in the main content area
- Leave space for a title and optional caption text
