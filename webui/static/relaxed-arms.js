"use strict";
/** Static resting pose for the DeepSeekNiang v4 skeleton. */
(() => {
  const joints = [
    { id: "ParamArmLA", rest: 7 },
    { id: "ParamArmRA", rest: 0 },
    { id: "ParamArmLB", rest: -90 },
    { id: "ParamArmRB", rest: -50 },
    { id: "ParamHandL", rest: 15 },
    { id: "ParamHandR", rest: 8 },
  ];
  const gestures = ["ParamGestureWave", "ParamGestureBowl", "ParamGestureCheer"];
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function installRelaxedArms(model, options = {}) {
    const internal = model.internalModel;
    const core = internal.coreModel;
    const parameters = core._model?.parameters;
    // Match this rig's native parameters and shoulder limits.
    if (!parameters || ![...joints.map(j => j.id), ...gestures, "ParamSkelUpperBody", "ParamSkelTailSwing"]
      .every(id => parameters.ids.includes(id))) return null;
    const rig = joints.map(j => ({ ...j, index: parameters.ids.indexOf(j.id) }));
    if (!rig.slice(0, 2).every(j => Math.abs(parameters.minimumValues[j.index] + 8) < .01
      && Math.abs(parameters.maximumValues[j.index] - 60) < .01)) return null;
    const gestureIndices = gestures.map(id => parameters.ids.indexOf(id));
    const enabled = options.enabled || (() => true);
    const manager = internal.motionManager;
    // Start in the chosen pose on the first visible frame, without a straight-arm
    // flash. Only toggles and returning from authored actions need a transition.
    let previousTime = model.elapsedTime, weight = enabled() ? 1 : 0, disposed = false;
    const update = () => {
      if (disposed) return;
      const elapsed = model.elapsedTime;
      const dt = Number.isFinite(elapsed) && Number.isFinite(previousTime)
        ? clamp((elapsed - previousTime) / 1000, 0, .1) : 1 / 60;
      previousTime = elapsed;
      const motion = manager.state;
      const gestureActive = gestureIndices.some(index => Math.abs(parameters.values[index]) > .01);
      const actionActive = motion.currentPriority > 1 || motion.reservePriority > 1;
      if (gestureActive || actionActive) { weight = 0; return; }
      const target = enabled() ? 1 : 0;
      weight += (target - weight) * (1 - Math.exp(-dt / .45));
      if (Math.abs(weight - target) < .0001) weight = target;
      if (weight === 0) return;
      for (const joint of rig) {
        const pose = clamp(joint.rest, parameters.minimumValues[joint.index], parameters.maximumValues[joint.index]);
        core.setParameterValueByIndex(joint.index, pose, weight);
      }
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      internal.off("beforeModelUpdate", update);
      model.off("destroy", dispose);
    };
    // Cubism restores its authored parameters after core.update(), so this pose
    // neither accumulates across frames nor changes the source model files.
    internal.on("beforeModelUpdate", update);
    model.on("destroy", dispose);
    return { dispose };
  }
  globalThis.Live2DStudio = { ...globalThis.Live2DStudio, installRelaxedArms };
})();
