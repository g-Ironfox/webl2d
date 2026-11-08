import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

export async function runColorTests(root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\\\/]$/, '')) {
  const vendor = await fs.readFile(`${root}/webui/static/vendor/cubism4.min.js`, 'utf8');
  const names = [
    'fragmentShaderSrcPremultipliedAlpha',
    'fragmentShaderSrcMaskPremultipliedAlpha',
    'fragmentShaderSrcMaskInvertedPremultipliedAlpha',
    'fragmentShaderSrcsetupMask',
  ];
  const sources = Object.fromEntries(names.map(name => {
    const alias = vendor.match(new RegExp(`t\\.${name}=([A-Za-z_$][\\w$]*)`))[1];
    const literal = vendor.match(new RegExp(`${alias}=("(?:[^"\\\\]|\\\\.)*")`))[1];
    return [name, JSON.parse(literal)];
  }));
  class Shader {
    constructor() {
      this.uploads = [];
      this.gl = {
        getUniformLocation: (program, name) => ({program, name}),
        uniform4fv: (location, values) => this.uploads.push({location, values: Array.from(values)}),
      };
      this._shaderSets = Array.from({length: 10}, () => ({shaderProgram: {}}));
    }
    loadShaderProgram(vertex, fragment) { return {vertex, fragment}; }
    setupShaderProgram() { return 'original-setup'; }
  }
  const runtime = {...sources, CubismShader_WebGL: Shader};
  const context = vm.createContext({PIXI: {live2d: runtime}, Float32Array, WeakMap, Set});
  const patch = await fs.readFile(`${root}/webui/static/cubism-colors.js`, 'utf8');
  new vm.Script(await fs.readFile(`${root}/webui/static/app.js`, 'utf8'));
  vm.runInContext(patch, context);
  const shader = new Shader();
  for (const name of names.slice(0, 3)) {
    const result = shader.loadShaderProgram('vertex', sources[name]).fragment;
    assert.match(result, /uniform vec4 u_multiplyColor/);
    assert.match(result, /uniform vec4 u_screenColor/);
    assert.match(result, /studioDrawableColor\(texture2D\(s_texture0/);
    assert.match(result, /\* u_baseColor/);
    assert.equal((result.match(/vec4 studioDrawableColor/g) || []).length, 1);
  }
  assert.equal(shader.loadShaderProgram('vertex', sources.fragmentShaderSrcsetupMask).fragment, sources.fragmentShaderSrcsetupMask);
  const originalPatchedSetup = Shader.prototype.setupShaderProgram;
  vm.runInContext(patch, context);
  assert.equal(Shader.prototype.setupShaderProgram, originalPatchedSetup, 'Installing twice must be harmless');

  // Read the real model's colors, rather than assuming a neutral nose color.
  const coreContext = vm.createContext({console, setTimeout, clearTimeout, WebAssembly, TextEncoder, TextDecoder, atob});
  vm.runInContext(await fs.readFile(`${root}/webui/static/vendor/live2dcubismcore.min.js`, 'utf8'), coreContext);
  await new Promise(resolve => setTimeout(resolve, 100));
  const core = coreContext.Live2DCubismCore;
  assert.ok(core.Version.csmGetLatestMocVersion() >= 5);
  const bytes = await fs.readFile(`${root}/asset/DeepSeek/大肥鱼.moc3`);
  const moc = core.Moc.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const model = core.Model.fromMoc(moc);
  model.update();
  const renderer = {
    mask: null, clip: null,
    getClippingContextBufferForMask() { return this.mask; },
    getClippingContextBufferForDraw() { return this.clip; },
    getModel() { return {_model: model}; },
  };
  for (const id of ['ArtMesh246', 'ArtMesh682']) {
    const i = model.drawables.ids.indexOf(id);
    assert.ok(i >= 0);
    const multiply = Array.from(model.drawables.multiplyColors.slice(i * 4, i * 4 + 4));
    const screen = Array.from(model.drawables.screenColors.slice(i * 4, i * 4 + 4));
    assert.deepEqual(multiply, [0, 0, 0, 1]);
    assert.ok(screen[0] > .95 && screen[1] > .9 && screen[2] > .9, 'The black source texture must be recolored to skin');
    for (const blend of [0, 1, 2]) {
      for (const clip of [null, {}]) {
        for (const inverted of [false, true]) {
          renderer.clip = clip;
          const args = [renderer, null, 0, model.drawables.vertexPositions[i], null, null, null, 1, blend, null, true, null, inverted];
          assert.equal(shader.setupShaderProgram(...args), 'original-setup');
          const uploads = shader.uploads.slice(-2);
          assert.deepEqual(uploads[0].values, multiply);
          assert.deepEqual(uploads[1].values, screen);
          const programIndex = 1 + blend * 3 + (clip ? (inverted ? 2 : 1) : 0);
          assert.equal(uploads[0].location.program, shader._shaderSets[programIndex].shaderProgram);
        }
      }
    }
  }
  const beforeMasks = shader.uploads.length;
  renderer.mask = {};
  shader.setupShaderProgram(renderer);
  assert.equal(shader.uploads.length, beforeMasks, 'Clipping-mask shaders must not receive drawable colors');
  const report = {
    noseColors: ['ArtMesh246', 'ArtMesh682'].map(id => {const i = model.drawables.ids.indexOf(id); return {id, multiply: Array.from(model.drawables.multiplyColors.slice(i*4,i*4+4)), screen: Array.from(model.drawables.screenColors.slice(i*4,i*4+4))};}),
    checks: '3 drawable shaders, original mask shader, all 3 blend modes, normal/inverted clipping, real nose colors, repeat installation',
  };
  model.release();
  moc._release();
  return report;
}

