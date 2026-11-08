# Browser runtimes

The page loads these files locally, in order:

1. `live2dcubismcore.min.js` — Live2D Cubism Core, from the official Live2D distribution.
2. `pixi.min.js` — PixiJS 6.5.10, MIT license.
3. `cubism4.min.js` — pixi-live2d-display 0.4.0, MIT license.

Run `python scripts/fetch_vendor.py` from the project root to populate missing files.
If the official Core endpoint is unavailable, obtain the Cubism SDK for Web from
https://www.live2d.com/en/sdk/download/web/ and copy
`Core/live2dcubismcore.min.js` into this directory.

Cubism Core is subject to the Live2D Proprietary Software License Agreement and
Live2D SDK release license. Its embedded notices must be preserved.
Official licensing information: https://www.live2d.com/en/sdk/license/
The model files retain their original authors' licenses.

Sources:
- https://github.com/pixijs/pixijs/tree/v6.5.10
- https://github.com/guansss/pixi-live2d-display/tree/v0.4.0
