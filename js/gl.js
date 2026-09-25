// Global adjustments on the GPU. One fragment shader, one pass.
// Falls back to a plain copy when WebGL is unavailable.

import { makeCanvas } from './util.js';

const VS = `
attribute vec2 p;
varying vec2 uv;
void main() {
  uv = vec2((p.x + 1.0) * 0.5, 1.0 - (p.y + 1.0) * 0.5);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FS = `
precision highp float;
varying vec2 uv;
uniform sampler2D tex;
uniform vec2 aspect;
uniform float exposure, contrast, highlights, shadows, saturation, warmth, tint, vignette;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
void main() {
  vec4 c = texture2D(tex, uv);
  vec3 col = c.rgb;
  if (exposure != 0.0) {
    col = pow(max(col, 0.0), vec3(2.2)) * exp2(exposure * 1.5);
    col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  }
  col.r += warmth * 0.07 + tint * 0.025;
  col.g -= tint * 0.05;
  col.b += -warmth * 0.08 + tint * 0.025;
  float l = dot(clamp(col, 0.0, 1.0), LUMA);
  col += highlights * 0.28 * smoothstep(0.45, 1.0, l);
  col += shadows * 0.28 * (1.0 - smoothstep(0.0, 0.55, l));
  float k = contrast >= 0.0 ? 1.0 + contrast * 0.9 : 1.0 + contrast * 0.6;
  col = (col - 0.5) * k + 0.5;
  l = dot(col, LUMA);
  col = mix(vec3(l), col, 1.0 + saturation);
  if (vignette != 0.0) {
    vec2 d = (uv - 0.5) * aspect;
    float r = length(d) / length(0.5 * aspect);
    float v = smoothstep(0.35, 1.05, r);
    if (vignette > 0.0) col *= 1.0 - vignette * 0.65 * v;
    else col = mix(col, vec3(1.0), -vignette * 0.55 * v);
  }
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);
}`;

const KEYS = ['exposure', 'contrast', 'highlights', 'shadows', 'saturation', 'warmth', 'tint', 'vignette'];

export function createAdjuster() {
  const canvas = makeCanvas(2, 2);
  let gl = null;
  try {
    gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: false });
  } catch {
    gl = null;
  }
  if (!gl) return fallback(canvas);

  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (e) {
    console.warn('BridgeBack: WebGL shader failed, sliders will not render.', e);
    return fallback(canvas);
  }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  const u = {};
  for (const k of [...KEYS, 'aspect', 'tex']) u[k] = gl.getUniformLocation(prog, k);
  gl.uniform1i(u.tex, 0);

  return {
    canvas,
    gpu: true,
    upload(src) {
      if (canvas.width !== src.width || canvas.height !== src.height) {
        canvas.width = src.width;
        canvas.height = src.height;
      }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    },
    render(values) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      for (const k of KEYS) gl.uniform1f(u[k], (values[k] || 0) / 100);
      const m = Math.max(canvas.width, canvas.height);
      gl.uniform2f(u.aspect, canvas.width / m, canvas.height / m);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}

function fallback(canvas) {
  const ctx = canvas.getContext('2d');
  let src = null;
  return {
    canvas,
    gpu: false,
    upload(s) {
      src = s;
      canvas.width = s.width;
      canvas.height = s.height;
    },
    render() {
      if (!src) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(src, 0, 0);
    },
  };
}
