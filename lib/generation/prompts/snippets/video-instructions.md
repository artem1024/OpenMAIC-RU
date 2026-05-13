### AI-Generated Video Requests

Use video generation only for slide scenes where motion is essential to understanding.

- Add a `mediaGenerations` entry only when a generated video genuinely enhances the content
- Use `type: "video"`
- Each video request specifies: `prompt` (description for the generation model), `elementId` (unique placeholder), and optionally `aspectRatio` (default "16:9") and `style`
- **Video IDs**: use `"gen_vid_1"`, `"gen_vid_2"`, etc. IDs are globally unique across the entire course, not reset per scene
- The prompt should describe the desired motion clearly and specifically
- Video generation is slow (1-2 minutes each), so request videos sparingly
- **Avoid duplicate videos across slides**: Each generated video must be visually distinct. Do not request near-identical videos for different slides. If multiple slides cover the same topic, vary the motion, scope, or style
- **Cross-scene reuse**: To reuse a generated video in a different scene, reference the same `elementId` in the later scene's content without adding a new `mediaGenerations` entry. Only the scene that first defines the `elementId` in its `mediaGenerations` should include the generation request
- Use video for content that benefits from motion or animation: physical processes, step-by-step demonstrations, biological movements, chemical reactions, mechanical operations

**⚠️ NO TEXT IN VIDEO — HARD RULE**: Video prompts MUST NOT request any on-screen text, labels, captions, titles, annotations, or written words in ANY language. Text-to-video models (Veo and others) render text as unreadable, garbled gibberish — and Cyrillic / non-Latin scripts come out especially broken (e.g. "Hidden" becomes "Hidond", "Output" becomes "Objuct"). ALWAYS:

- Describe videos as purely visual/animated: motion, shapes, colors, flows, transitions.
- Explicitly add `"no text, no letters, no labels, no captions, no words"` to the end of every video prompt.
- If a concept needs labels (layer names, formulas, terms), put them in a SEPARATE text element on the slide — not inside the video.
- Bad example: `"animation of a neural network with input, hidden, and output layers labeled"` ❌
- Good example: `"smooth animation of a neural network with glowing nodes pulsing and signals flowing left to right across connecting lines, abstract educational style, no text, no letters, no labels"` ✅

Video example:

```json
"mediaGenerations": [
  {
    "type": "video",
    "prompt": "A smooth animation showing water molecules evaporating from the ocean surface, rising into the atmosphere, and forming clouds, abstract educational style, no text, no letters, no labels, no captions, no words",
    "elementId": "gen_vid_1",
    "aspectRatio": "16:9"
  }
]
```
