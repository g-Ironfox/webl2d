import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';

export async function runArmTests(root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')) {
  const script = await fs.readFile(`${root}/webui/static/relaxed-arms.js`, 'utf8');
  const context = vm.createContext({});
  vm.runInContext(script, context);
  const install = context.Live2DStudio.installRelaxedArms;
  assert.equal(install({internalModel: {coreModel: {_model: {parameters: {ids: []}}}}}), null);
  new vm.Script(await fs.readFile(`${root}/webui/static/app.js`, 'utf8'));

  const runtime = vm.createContext({console, setTimeout, clearTimeout, WebAssembly, TextEncoder, TextDecoder, atob});
  vm.runInContext(await fs.readFile(`${root}/webui/static/vendor/live2dcubismcore.min.js`, 'utf8'), runtime);
  await new Promise(resolve => setTimeout(resolve, 100));
  const bytes = await fs.readFile(`${root}/asset/DeepSeekNiang_v4/DeepSeekNiang.moc3`);
  const moc = runtime.Live2DCubismCore.Moc.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const native = runtime.Live2DCubismCore.Model.fromMoc(moc);
  try {
    const parameters = native.parameters;
    const jointIds = ['ParamArmLA', 'ParamArmRA', 'ParamArmLB', 'ParamArmRB', 'ParamHandL', 'ParamHandR'];
    const values = () => Object.fromEntries(jointIds.map(id => [id, parameters.values[parameters.ids.indexOf(id)]]));
    const internal = new EventEmitter();
    let writes = 0;
    internal.motionManager = {state: {currentPriority: 1, reservePriority: 0}};
    internal.coreModel = {
      _model: native,
      setParameterValueByIndex(index, value, weight) {
        writes++;
        value = Math.max(parameters.minimumValues[index], Math.min(parameters.maximumValues[index], value));
        parameters.values[index] = parameters.values[index] * (1 - weight) + value * weight;
      },
    };
    const model = new EventEmitter(); model.internalModel = internal; model.elapsedTime = 0;
    let enabled = true;
    const control = install(model, {enabled: () => enabled});
    assert.ok(control);
    function frame(dt = 1000/60, overrides = {}) {
      parameters.values.set(parameters.defaultValues);
      for (const [id, value] of Object.entries(overrides)) parameters.values[parameters.ids.indexOf(id)] = value;
      model.elapsedTime += dt;
      internal.emit('beforeModelUpdate');
      for (const id of jointIds) {
        const i = parameters.ids.indexOf(id);
        assert.ok(parameters.values[i] >= parameters.minimumValues[i] && parameters.values[i] <= parameters.maximumValues[i]);
      }
      return values();
    }
    native.update();
    const mesh = native.drawables.ids.indexOf('ArtMeshForearmL');
    const outerX = () => Math.max(...Array.from(native.drawables.vertexPositions[mesh]).filter((_, i) => i % 2 === 0));
    const originalX = outerX();
    const first = frame(0);
    assert.ok(first.ParamArmLB <= -75, 'The first rendered frame must already have a visibly bent elbow');
    assert.ok(Math.abs(first.ParamArmLB - first.ParamArmRB) > 25, 'The initial pose must have distinct left and right elbow angles');
    native.update();
    assert.ok(outerX() < originalX - .1, 'The real model hand must move inward, onto the apron');
    for (let i=0; i<180; i++) {
      // The two authored Idle motions contain different joint poses. Both must
      // use the same static resting pose, without a time-dependent arm sway.
      const authored = i % 2 ? {ParamArmLB: -32, ParamArmRB: -31, ParamHandL: -3} : {};
      assert.deepEqual(frame(1000/60, authored), first, 'Initial posture must remain stable across idle motion samples');
    }
    for (const id of ['ParamGestureWave', 'ParamGestureBowl', 'ParamGestureCheer']) {
      const before = writes; frame(16, {[id]: 1}); assert.equal(writes, before, `${id} must keep control of its own pose`);
    }
    for (const key of ['currentPriority', 'reservePriority']) {
      internal.motionManager.state[key] = 3;
      const before = writes; frame(); assert.equal(writes, before, 'User actions must take priority');
      internal.motionManager.state[key] = key === 'currentPriority' ? 1 : 0;
    }
    for (let i=0; i<180; i++) frame();
    enabled=false;
    const fading = frame(); assert.ok(Math.abs(fading.ParamArmLB)>10, 'Switching off must fade rather than snap');
    for (let i=0; i<360; i++) frame();
    for (const value of Object.values(values())) assert.equal(value,0, 'Disabled overlay must return to the original authored values');
    enabled=true;
    for(let i=0;i<360;i++) frame();
    const rest = values(); const later = frame(60000);
    assert.deepEqual(later, rest, 'The resting pose stays still, including after a long pause');
    const beforeDestroy = writes;
    model.emit('destroy'); frame(); assert.equal(writes,beforeDestroy);
    assert.equal(internal.listenerCount('beforeModelUpdate'),0);
    control.dispose();
    return {model: 'DeepSeekNiang_v4', originalHandOuterX: originalX, relaxedPose: rest, checks: 'bent asymmetric first frame, static pose across authored idle samples, native mesh position, joint limits, toggle transitions, 3 gestures, active and pending actions, long pauses, destroy cleanup, unsupported rigs'};
  } finally { native.release(); moc._release(); }
}
