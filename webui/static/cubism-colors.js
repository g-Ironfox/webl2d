"use strict";
/**
 * Multiply/screen color support for the pinned pixi-live2d-display 0.4.0 renderer.
 * Cubism Core supplies these colors per drawable, including nose meshes whose
 * source texture is black. Apply the official premultiplied-alpha color formula
 * before the renderer's model tint and clipping. Mask generation stays unchanged.
 * https://docs.live2d.com/en/cubism-sdk-manual/multiply-color-screen-color-web/
 */
(() => {
  const runtime = globalThis.PIXI?.live2d;
  if (!runtime || runtime.__studioColorSupport) return;
  const prototype = runtime.CubismShader_WebGL.prototype;
  const originalLoad = prototype.loadShaderProgram;
  const originalSetup = prototype.setupShaderProgram;
  const drawableShaders = new Set([
    runtime.fragmentShaderSrcPremultipliedAlpha,
    runtime.fragmentShaderSrcMaskPremultipliedAlpha,
    runtime.fragmentShaderSrcMaskInvertedPremultipliedAlpha,
  ]);
  const uniformLocations = new WeakMap();
  const vertexIndices = new WeakMap();
  const white = new Float32Array([1, 1, 1, 1]);
  const black = new Float32Array([0, 0, 0, 1]);

  prototype.loadShaderProgram = function (vertexSource, fragmentSource) {
    if (drawableShaders.has(fragmentSource)) {
      const colorFunction = `
        uniform vec4 u_multiplyColor;
        uniform vec4 u_screenColor;
        vec4 studioDrawableColor(vec4 color) {
          color.rgb *= u_multiplyColor.rgb;
          color.rgb = color.rgb + u_screenColor.rgb * color.a
                      - color.rgb * u_screenColor.rgb;
          return color;
        }
      `;
      fragmentSource = fragmentSource
        .replace(/texture2D\(s_texture0\s*,\s*v_texCoord\)/g, (sample) => `studioDrawableColor(${sample})`)
        .replace("void main()", `${colorFunction}\nvoid main()`);
    }
    return originalLoad.call(this, vertexSource, fragmentSource);
  };

  prototype.setupShaderProgram = function (...args) {
    const renderer = args[0];
    const isMask = renderer.getClippingContextBufferForMask() != null;
    const result = originalSetup.apply(this, args);
    if (isMask) return result;

    // These internal fields belong to the pinned 0.4.0 CubismModel wrapper.
    const core = renderer.getModel()._model;
    if (!core?.drawables) return result;
    let indices = vertexIndices.get(core);
    if (!indices) {
      indices = new WeakMap();
      core.drawables.vertexPositions.forEach((vertices, index) => indices.set(vertices, index));
      vertexIndices.set(core, indices);
    }
    const index = indices.get(args[3]);
    const blend = args[8];
    const clip = renderer.getClippingContextBufferForDraw();
    const shaderIndex = 1 + (blend === 1 ? 3 : blend === 2 ? 6 : 0) + (clip ? (args[12] ? 2 : 1) : 0);
    const program = this._shaderSets[shaderIndex].shaderProgram;
    let locations = uniformLocations.get(program);
    if (!locations) {
      locations = {
        multiply: this.gl.getUniformLocation(program, "u_multiplyColor"),
        screen: this.gl.getUniformLocation(program, "u_screenColor"),
      };
      uniformLocations.set(program, locations);
    }
    const offset = index * 4;
    this.gl.uniform4fv(locations.multiply, index !== undefined && core.drawables.multiplyColors
      ? core.drawables.multiplyColors.subarray(offset, offset + 4) : white);
    this.gl.uniform4fv(locations.screen, index !== undefined && core.drawables.screenColors
      ? core.drawables.screenColors.subarray(offset, offset + 4) : black);
    return result;
  };
  runtime.__studioColorSupport = true;
})();
