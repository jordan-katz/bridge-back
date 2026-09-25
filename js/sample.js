// A small flat illustration so the editor opens with something to try.

import { makeCanvas } from './util.js';

export function sampleScene() {
  const W = 1600, H = 1000;
  const c = makeCanvas(W, H);
  const x = c.getContext('2d');

  const sky = x.createLinearGradient(0, 0, 0, 700);
  sky.addColorStop(0, '#6fa6de');
  sky.addColorStop(0.7, '#bcd6ea');
  sky.addColorStop(1, '#f1dcb8');
  x.fillStyle = sky;
  x.fillRect(0, 0, W, H);

  const glow = x.createRadialGradient(1230, 250, 40, 1230, 250, 260);
  glow.addColorStop(0, 'rgba(255,236,170,.9)');
  glow.addColorStop(1, 'rgba(255,236,170,0)');
  x.fillStyle = glow;
  x.fillRect(900, 0, 700, 560);
  x.fillStyle = '#ffe39a';
  x.beginPath();
  x.arc(1230, 250, 68, 0, Math.PI * 2);
  x.fill();

  x.fillStyle = '#f7f9fb';
  for (const [cx, cy, s] of [[380, 170, 1], [640, 120, 0.7], [1450, 420, 0.8]]) {
    for (const [ox, oy, rx, ry] of [[0, 0, 90, 30], [55, -18, 60, 34], [-60, -8, 50, 26]]) {
      x.beginPath();
      x.ellipse(cx + ox * s, cy + oy * s, rx * s, ry * s, 0, 0, Math.PI * 2);
      x.fill();
    }
  }

  x.fillStyle = '#9db2c7';
  x.beginPath();
  x.moveTo(0, 620);
  x.lineTo(180, 470); x.lineTo(330, 560); x.lineTo(520, 420); x.lineTo(760, 590);
  x.lineTo(1010, 440); x.lineTo(1250, 575); x.lineTo(1430, 470); x.lineTo(1600, 560);
  x.lineTo(1600, 700); x.lineTo(0, 700);
  x.fill();

  x.fillStyle = '#7ea66c';
  x.beginPath();
  x.moveTo(0, 660);
  x.quadraticCurveTo(420, 590, 820, 650);
  x.quadraticCurveTo(1200, 705, 1600, 630);
  x.lineTo(1600, H); x.lineTo(0, H);
  x.fill();

  x.fillStyle = '#5f8f4e';
  x.beginPath();
  x.moveTo(0, 760);
  x.quadraticCurveTo(700, 700, 1600, 780);
  x.lineTo(1600, H); x.lineTo(0, H);
  x.fill();

  x.fillStyle = '#d8c49a';
  x.beginPath();
  x.moveTo(735, 744); x.lineTo(805, 744); x.lineTo(900, H); x.lineTo(640, H);
  x.fill();

  // House
  x.fillStyle = '#e8dcc6';
  x.fillRect(560, 470, 420, 262);
  x.fillStyle = '#7d2f25';
  x.fillRect(880, 360, 40, 90);
  x.fillStyle = '#9c3b2e';
  x.beginPath();
  x.moveTo(530, 482); x.lineTo(770, 330); x.lineTo(1010, 482);
  x.fill();
  x.fillStyle = '#5a4636';
  for (const wx of [610, 850]) x.fillRect(wx - 6, 534, 92, 82);
  x.fillStyle = '#cfe6f5';
  for (const wx of [610, 850]) x.fillRect(wx, 540, 80, 70);
  x.fillStyle = '#5a4636';
  for (const wx of [610, 850]) {
    x.fillRect(wx + 38, 540, 4, 70);
    x.fillRect(wx, 573, 80, 4);
  }
  x.fillStyle = '#c2362b';
  x.fillRect(735, 590, 70, 142);
  x.fillStyle = '#e9c46a';
  x.beginPath();
  x.arc(790, 664, 5, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = '#b9ad98';
  x.fillRect(718, 732, 104, 14);

  // Tree
  x.fillStyle = '#6b4a2f';
  x.fillRect(300, 520, 36, 205);
  for (const [cx, cy, r, col] of [
    [318, 450, 105, '#3f7d3a'], [250, 500, 70, '#4a8c41'], [390, 495, 72, '#4a8c41'], [320, 380, 70, '#56a04b'],
  ]) {
    x.fillStyle = col;
    x.beginPath();
    x.arc(cx, cy, r, 0, Math.PI * 2);
    x.fill();
  }

  return {
    canvas: c,
    spots: {
      door: { a: { x: 733, y: 588 }, b: { x: 807, y: 734 } },
      tree: { a: { x: 170, y: 300 }, b: { x: 470, y: 735 } },
      step: { x: 770, y: 728 },
    },
  };
}
