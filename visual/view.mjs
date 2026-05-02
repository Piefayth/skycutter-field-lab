import * as THREE from "three";

import { H, TAU, W, idx } from "../kernel/kernel.mjs";

// Render the active recipe's selected view onto the globe texture.
//
// `viewSpec` comes from the recipe's `views[]` declaration, where each
// entry has `{ id, label, color }`. `color` is a per-cell colorer
// function with signature
//
//   (i, fields) => [r, g, b]   (0-255 ints).
//
// Wind-aware colorers (e.g. `windMagnitude`) read `fields.windU` /
// `fields.windV` directly. There's no special positional argument for
// wind anymore — windU/windV are recipe-declared fields like everything
// else. Forcing-map fields (e.g. `moistureSource`) are also just
// fields after the v4 sources/fields collapse.
export function createView({
  renderer,
  texCtx,
  imageData,
  fieldTexture,
  globe,
  arrows,
  arrowGeometry,
}) {
  let currentImageData = imageData;
  return {
    updateTexture({ fields, viewSpec }) {
      if (currentImageData.width !== W || currentImageData.height !== H) {
        texCtx.canvas.width = W;
        texCtx.canvas.height = H;
        currentImageData = texCtx.createImageData(W, H);
        fieldTexture.dispose();
        fieldTexture.image = texCtx.canvas;
        fieldTexture.source.data = texCtx.canvas;
        if (globe?.material) {
          if (globe.material.uniforms?.u_map) globe.material.uniforms.u_map.value = fieldTexture;
          else globe.material.map = fieldTexture;
          globe.material.needsUpdate = true;
        }
      }
      const color = typeof viewSpec?.color === "function" ? viewSpec.color : null;
      const writeColor = typeof color?.write === "function" ? color.write : null;
      const data = currentImageData.data;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = idx(x, y);
          const k = i * 4;
          if (writeColor) {
            writeColor(i, fields, data, k);
          } else {
            const c = color ? color(i, fields) : BLACK;
            data[k + 0] = c[0];
            data[k + 1] = c[1];
            data[k + 2] = c[2];
          }
          data[k + 3] = 255;
        }
      }
      texCtx.putImageData(currentImageData, 0, 0);
      fieldTexture.needsUpdate = true;
    },

    updateArrows({ windU, windV, showArrows }) {
      if (renderer?.fieldLabBackend === "webgpu") {
        arrows.visible = false;
        return;
      }
      arrows.visible = showArrows && windU && windV;
      if (!arrows.visible) return;
      const positions = [];
      const stepX = 12;
      const stepY = 8;
      for (let y = 6; y < H - 6; y += stepY) {
        for (let x = 0; x < W; x += stepX) {
          const i = idx(x, y);
          const mag = Math.hypot(windU[i], windV[i]);
          if (mag < 0.01) continue;
          const lon = (x / W) * TAU - Math.PI;
          const lat = (y / (H - 1) - 0.5) * Math.PI;
          const p0 = spherePoint(lon, lat, 1.015);
          const p1 = spherePoint(lon + windU[i] * 0.035, lat + windV[i] * 0.025, 1.018);
          positions.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
        }
      }
      arrowGeometry.dispose();
      arrowGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      arrowGeometry.setDrawRange(0, positions.length / 3);
      arrowGeometry.computeBoundingSphere();
    },
  };
}

const BLACK = [0, 0, 0];

function spherePoint(lon, lat, radius) {
  const c = Math.cos(lat);
  return new THREE.Vector3(Math.cos(lon) * c * radius, Math.sin(lat) * radius, Math.sin(lon) * c * radius);
}
