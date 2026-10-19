# APIMart Seedream-5.0-Pro layer decomposition reference

## Verified API contract

- Submit tasks with `POST https://api.apimart.ai/v1/images/generations`
- Authenticate with `Authorization: Bearer <token>`
- Use `model: "seedream-5-0-pro"` or `model: "seedream-5.0-pro"`
- Poll task status with `GET /v1/tasks/{task_id}`
- The model is asynchronous and returns a task ID first

## Verified decomposition behavior

- `layer_decomposition: true` enables image layer decomposition
- When `prompt` is omitted, the model automatically identifies and separates the main elements in the image
- The result is one base image plus up to 16 PNG layers with alpha channels
- Decomposition requires exactly one PNG or JPEG image
- The accepted `size` values for decomposition are `1K`, `1.5K`, `2K`, and `auto`
- Exact-pixel `size` values are not documented for layer decomposition and should be avoided there

## Verified limits that matter for skill logic

- Only one image is supported for this model request path
- `n > 1` is rejected
- More than 10 items in `image_urls` is rejected, but layer decomposition itself still uses one image
- `size` and `resolution` both exist, but for decomposition use only the documented tier values

## Mode guidance

### Auto split
Use when the user says:
- 自动拆分
- 极限拆分
- 直接拆层
- 让模型自己拆

Behavior:
- Omit `prompt`
- Expect the model to infer main elements
- Do not guarantee a fixed number of layers

### Guided split
Use when the user says:
- 拆成文字、背景、草、土壤
- 按元素拆
- 按区域拆
- 只把某个局部提出来

Behavior:
- Keep `layer_decomposition: true`
- Add a short prompt naming the targets
- Add `<bbox>x1 y1 x2 y2</bbox>` for precise regions when needed

## Prompt pattern

Prefer a short prompt like:
- `Separate the image into text, soil, grass, and bread.`
- `Split the image into a clean background layer, foreground plant layer, and object layer.`
- `Extract the subject at <bbox>180 64 812 198</bbox> into a separate layer.`

## What not to assume

- Do not assume the model can be forced to return exactly 4 layers
- Do not assume omitted prompt means “maximum possible layers”
- Do not assume exact-pixel sizing is part of the decomposition path
- Do not assume every semantic part will become a separate layer if the model thinks it should stay merged

## Practical defaults

- Default to `1.5K` unless the image is text-heavy or poster-like
- Upgrade to `2K` when the output must preserve small details
- Use `auto` only when the user does not care about the tier

## Mandatory background policy

For PSD workflows, background is not optional. Every split request must ask for a separate clean background layer. If APIMart does not return one, the local script must synthesize `01_background-forced.png` from the base image using the alpha masks of returned foreground layers, then include that forced background in the PSD. Target layer counts are best-effort and must not override this background requirement.
