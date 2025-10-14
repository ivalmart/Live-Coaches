import * as retro from "https://cdn.skypack.dev/pin/snes9x-next@v1.0.0-cli3XObByFqiqSouAHTv/mode=imports,min/optimized/snes9x-next.js";
import * as thingpixel from "https://cdn.skypack.dev/pin/@thi.ng/pixel@v4.2.7-YzsdE4qjK7uUqur4AuyF/mode=imports,min/optimized/@thi.ng/pixel.js";

// Super Nintendo Entertainment System code to run on webpage window
export function emulateSnesConsole(romBytes, stateBytes, container) {
  const emulator = new EventTarget();
  emulator.retro = retro;
  const input_state = (emulator.input_state = {});

  const av_info = retro.get_system_av_info();

  const canvas = (emulator.canvas = document.createElement("canvas"));
  const width = av_info.geometry.base_width;
  const height = av_info.geometry.base_height;
  canvas.setAttribute("width", width);
  canvas.setAttribute("height", height);
  canvas.setAttribute("tabindex", 0);
  container.append(canvas);

  const context = canvas.getContext("2d");
  const imageData = context.createImageData(width, height);

  const environment_command_names = {};
  for (let [k, v] of Object.entries(retro)) {
    if (k.startsWith("ENVIRONMENT")) {
      environment_command_names[v] = k;
    }
  }

  retro.set_environment((cmd, data) => {
    //console.log('environment', environment_command_names[cmd], data);
    if (cmd == retro.ENVIRONMENT_GET_LOG_INTERFACE) {
      return function (level, msg) {
        // console.log("retro log", level, msg);
      };
    } else {
      return true;
    }
  });

  retro.set_input_poll(() => {
    //console.log('input_poll');
  });

  retro.set_input_state((port, device, input, id) => {
    //console.log('input_state', port, device, input, id);
    const key = [port, device, input, id].toString();
    if (input_state[key]) {
      return input_state[key];
    } else {
      return 0; // not pressed by default
    }
  });

  retro.set_video_refresh((data, width, height, pitch) => {
    //console.log('video_refresh', data, width, height, pitch);
    const buffer = new thingpixel.IntBuffer(
      pitch / 2,
      height,
      thingpixel.RGB565,
      data
    );
    buffer.getRegion(0, 0, width, height).toImageData(imageData);
    context.putImageData(imageData, 0, 0);
  });

  retro.set_audio_sample_batch((left, right, frames) => {
    //console.log('audio_sample_batch', left, right, frames);
    return frames;
  });

  retro.init();

  let running = true;
  let agent = null;

  retro.load_game(romBytes);
  if (stateBytes) {
    retro.unserialize(stateBytes);
  }

/*
  let state = retro.serialize();
  model.set("result", Array.from(state));
  model.save_changes();
*/

  function tick() {
    if (running) {
      try {
        emulator.dispatchEvent(new Event("beforeRun"));
        retro.run();
        emulator.dispatchEvent(new Event("afterRun"));
      } catch (err) {
        console.log("err", err);
      }
    }
  }

  setInterval(tick, 1000/60);
  

  // canvas.addEventListener("click", () => {
  //   running = !running;
  //   if (running) {
  //     requestAnimationFrame(tick);
  //   }
  // });

  return emulator;
}
