// Icônes Lucide 0.460.0, embarquées pour fonctionner sans Internet. Licence : licenses/LUCIDE_LICENSE.txt.
'use strict';

const ICONS = {
  'unlink': "<path d=\"m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71\" /><path d=\"m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71\" /><line x1=\"8\" x2=\"8\" y1=\"2\" y2=\"5\" /><line x1=\"2\" x2=\"5\" y1=\"8\" y2=\"8\" /><line x1=\"16\" x2=\"16\" y1=\"19\" y2=\"22\" /><line x1=\"19\" x2=\"22\" y1=\"16\" y2=\"16\" />",
  'link': "<path d=\"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71\" /><path d=\"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71\" />",
  'cpu': "<rect width=\"16\" height=\"16\" x=\"4\" y=\"4\" rx=\"2\" /><rect width=\"6\" height=\"6\" x=\"9\" y=\"9\" rx=\"1\" /><path d=\"M15 2v2\" /><path d=\"M15 20v2\" /><path d=\"M2 15h2\" /><path d=\"M2 9h2\" /><path d=\"M20 15h2\" /><path d=\"M20 9h2\" /><path d=\"M9 2v2\" /><path d=\"M9 20v2\" />",
  'languages': "<path d=\"m5 8 6 6\" /><path d=\"m4 14 6-6 2-3\" /><path d=\"M2 5h12\" /><path d=\"M7 2h1\" /><path d=\"m22 22-5-10-5 10\" /><path d=\"M14 18h6\" />",
  'type': "<polyline points=\"4 7 4 4 20 4 20 7\" /><line x1=\"9\" x2=\"15\" y1=\"20\" y2=\"20\" /><line x1=\"12\" x2=\"12\" y1=\"4\" y2=\"20\" />",
  'image': "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" ry=\"2\" /><circle cx=\"9\" cy=\"9\" r=\"2\" /><path d=\"m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21\" />",
  'dices': "<rect width=\"12\" height=\"12\" x=\"2\" y=\"10\" rx=\"2\" ry=\"2\" /><path d=\"m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6\" /><path d=\"M6 18h.01\" /><path d=\"M10 14h.01\" /><path d=\"M15 6h.01\" /><path d=\"M18 9h.01\" />",
  'upload': "<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\" /><polyline points=\"17 8 12 3 7 8\" /><line x1=\"12\" x2=\"12\" y1=\"3\" y2=\"15\" />",
  'sparkles': "<path d=\"M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z\" /><path d=\"M20 3v4\" /><path d=\"M22 5h-4\" /><path d=\"M4 17v2\" /><path d=\"M5 18H3\" />",
  'box': "<path d=\"M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z\" /><path d=\"m3.3 7 8.7 5 8.7-5\" /><path d=\"M12 22V12\" />",
  'repeat': "<path d=\"m17 2 4 4-4 4\" /><path d=\"M3 11v-1a4 4 0 0 1 4-4h14\" /><path d=\"m7 22-4-4 4-4\" /><path d=\"M21 13v1a4 4 0 0 1-4 4H3\" />",
  'eye': "<path d=\"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0\" /><circle cx=\"12\" cy=\"12\" r=\"3\" />",
  'chevron-down': "<path d=\"m6 9 6 6 6-6\" />",
  'plus': "<path d=\"M5 12h14\" /><path d=\"M12 5v14\" />",
  'minus': "<path d=\"M5 12h14\" />",
  'play': "<polygon points=\"6 3 20 12 6 21 6 3\" />",
  'square': "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" />",
  'download': "<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\" /><polyline points=\"7 10 12 15 17 10\" /><line x1=\"12\" x2=\"12\" y1=\"15\" y2=\"3\" />",
  'x': "<path d=\"M18 6 6 18\" /><path d=\"m6 6 12 12\" />",
  'check': "<path d=\"M20 6 9 17l-5-5\" />",
  'trash-2': "<path d=\"M3 6h18\" /><path d=\"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6\" /><path d=\"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2\" /><line x1=\"10\" x2=\"10\" y1=\"11\" y2=\"17\" /><line x1=\"14\" x2=\"14\" y1=\"11\" y2=\"17\" />",
  'paintbrush': "<path d=\"m14.622 17.897-10.68-2.913\" /><path d=\"M18.376 2.622a1 1 0 1 1 3.002 3.002L17.36 9.643a.5.5 0 0 0 0 .707l.944.944a2.41 2.41 0 0 1 0 3.408l-.944.944a.5.5 0 0 1-.707 0L8.354 7.348a.5.5 0 0 1 0-.707l.944-.944a2.41 2.41 0 0 1 3.408 0l.944.944a.5.5 0 0 0 .707 0z\" /><path d=\"M9 8c-1.804 2.71-3.97 3.46-6.583 3.948a.507.507 0 0 0-.302.819l7.32 8.883a1 1 0 0 0 1.185.204C12.735 20.405 16 16.792 16 15\" />",
  'list': "<path d=\"M3 12h.01\" /><path d=\"M3 18h.01\" /><path d=\"M3 6h.01\" /><path d=\"M8 12h13\" /><path d=\"M8 18h13\" /><path d=\"M8 6h13\" />",
  'maximize-2': "<polyline points=\"15 3 21 3 21 9\" /><polyline points=\"9 21 3 21 3 15\" /><line x1=\"21\" x2=\"14\" y1=\"3\" y2=\"10\" /><line x1=\"3\" x2=\"10\" y1=\"21\" y2=\"14\" />",
  'eraser': "<path d=\"m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21\" /><path d=\"M22 21H7\" /><path d=\"m5 11 9 9\" />",
  'lasso': "<path d=\"M7 22a5 5 0 0 1-2-4\" /><path d=\"M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-5-1\" /><path d=\"M5 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z\" />",
  'square-dashed': "<path d=\"M5 3a2 2 0 0 0-2 2\" /><path d=\"M19 3a2 2 0 0 1 2 2\" /><path d=\"M21 19a2 2 0 0 1-2 2\" /><path d=\"M5 21a2 2 0 0 1-2-2\" /><path d=\"M9 3h1\" /><path d=\"M9 21h1\" /><path d=\"M14 3h1\" /><path d=\"M14 21h1\" /><path d=\"M3 9v1\" /><path d=\"M21 9v1\" /><path d=\"M3 14v1\" /><path d=\"M21 14v1\" />",
  'history': "<path d=\"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8\" /><path d=\"M3 3v5h5\" /><path d=\"M12 7v5l4 2\" />",
  'stamp': "<path d=\"M5 22h14\" /><path d=\"M19.27 13.73A2.5 2.5 0 0 0 17.5 13h-11A2.5 2.5 0 0 0 4 15.5V17a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1.5c0-.66-.26-1.3-.73-1.77Z\" /><path d=\"M14 13V8.5C14 7 15 7 15 5a3 3 0 0 0-3-3c-1.66 0-3 1-3 3s1 2 1 3.5V13\" />",
  'crop': "<path d=\"M6 2v14a2 2 0 0 0 2 2h14\" /><path d=\"M18 22V8a2 2 0 0 0-2-2H2\" />",
  'undo-2': "<path d=\"M9 14 4 9l5-5\" /><path d=\"M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11\" />",
  'redo-2': "<path d=\"m15 14 5-5-5-5\" /><path d=\"M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13\" />",
  'maximize': "<path d=\"M8 3H5a2 2 0 0 0-2 2v3\" /><path d=\"M21 8V5a2 2 0 0 0-2-2h-3\" /><path d=\"M3 16v3a2 2 0 0 0 2 2h3\" /><path d=\"M16 21h3a2 2 0 0 0 2-2v-3\" />",
  'rotate-cw': "<path d=\"M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8\" /><path d=\"M21 3v5h-5\" />",
  'flip-horizontal': "<path d=\"M8 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h3\" /><path d=\"M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3\" /><path d=\"M12 20v2\" /><path d=\"M12 14v2\" /><path d=\"M12 8v2\" /><path d=\"M12 2v2\" />",
};

// Dessinés ici : les emojis drapeaux ne s'affichent pas dans Chrome sous Windows.
const FLAGS = {
  en: '<rect width="60" height="40" fill="#012169"/><path d="M0 0 60 40M60 0 0 40" stroke="#fff" stroke-width="8"/><path d="M0 0 60 40M60 0 0 40" stroke="#c8102e" stroke-width="3"/><path d="M30 0v40M0 20h60" stroke="#fff" stroke-width="13"/><path d="M30 0v40M0 20h60" stroke="#c8102e" stroke-width="8"/>',
  fr: '<rect width="20" height="40" fill="#0055a4"/><rect x="20" width="20" height="40" fill="#fff"/><rect x="40" width="20" height="40" fill="#ef4135"/>',
  es: '<rect width="60" height="40" fill="#aa151b"/><rect y="10" width="60" height="20" fill="#f1bf00"/>',
  de: '<rect width="60" height="14" fill="#000"/><rect y="13" width="60" height="14" fill="#dd0000"/><rect y="27" width="60" height="13" fill="#ffce00"/>',
  it: '<rect width="20" height="40" fill="#009246"/><rect x="20" width="20" height="40" fill="#fff"/><rect x="40" width="20" height="40" fill="#ce2b37"/>',
};

function flagSvg(language) {
  return `<svg class="flag" viewBox="0 0 60 40" aria-hidden="true">${FLAGS[language] || ''}</svg>`;
}

function iconSvg(name) {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}
