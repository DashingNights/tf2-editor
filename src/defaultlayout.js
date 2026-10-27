// The default dock layout (layout.js): the tool panels round the viewports, as the editor was set up on 2026-10-21 (a
// dockview toJSON() of a 2048 x 1059 workspace; dockview lays it out at the real size, the viewports taking the
// difference). panels: the panel ids that existed then, so the ones missing from the dock (Compile, Undo) start closed
// and a panel added since opens as a tab.
export const DEFAULT_LAYOUT = {
  dock: {
    grid: { width: 2048, height: 1059, orientation: 'VERTICAL', root:
      { type: 'branch', size: 2048, data: [
        { type: 'branch', size: 63, data: [
          { type: 'leaf', size: 443, data: { views: ['tools-file', 'tools-map', 'tools-edit'], activeView: 'tools-file', id: '3' } },
          { type: 'leaf', size: 560, data: { views: ['tools-main'], activeView: 'tools-main', id: '9' } },
          { type: 'leaf', size: 1045, data: { views: ['tools-mirror'], activeView: 'tools-mirror', id: '6' } },
        ] },
        { type: 'branch', size: 996, data: [
          { type: 'leaf', size: 322.6, data: { views: ['outliner'], activeView: 'outliner', id: '10' } },
          { type: 'branch', size: 1381, data: [
            { type: 'branch', size: 85, data: [
              { type: 'leaf', size: 655, data: { views: ['tools-view'], activeView: 'tools-view', id: '14' } },
              { type: 'leaf', size: 485, data: { views: ['tools-gizmo'], activeView: 'tools-gizmo', id: '16' } },
              { type: 'leaf', size: 241, data: { views: ['tools-grid'], activeView: 'tools-grid', id: '15' } },
            ] },
            { type: 'branch', size: 911, data: [
              { type: 'branch', size: 1121, data: [
                { type: 'leaf', size: 470, data: { views: ['3d'], activeView: '3d', id: '5' } },
                { type: 'leaf', size: 441, data: { views: ['front', 'side', 'top', 'textures', 'models', 'sounds', 'prefabs'], activeView: 'top', id: '21' } },
              ] },
              { type: 'branch', size: 260, data: [
                { type: 'leaf', size: 174, data: { views: ['tools-select'], activeView: 'tools-select', id: '1' } },
                { type: 'leaf', size: 71, data: { views: ['tools-level'], activeView: 'tools-level', id: '2' } },
                { type: 'leaf', size: 240, data: { views: ['tools-brush', 'tools-cordon'], activeView: 'tools-brush', id: '4' } },
                { type: 'leaf', size: 426, data: { views: ['tools'], activeView: 'tools', id: '13' } },
              ] },
            ] },
          ] },
          { type: 'leaf', size: 344.4, data: { views: ['details', 'displacement', 'figmadiff'], activeView: 'details', id: '11' } },
        ] },
      ] } },
    panels: {
      'tools-file': { id: 'tools-file', contentComponent: 'tools-file', title: 'File', minimumHeight: 60, minimumWidth: 160 },
      'tools-map': { id: 'tools-map', contentComponent: 'tools-map', title: 'Map', minimumHeight: 60, minimumWidth: 160 },
      'tools-edit': { id: 'tools-edit', contentComponent: 'tools-edit', title: 'Clipboard', minimumHeight: 60, minimumWidth: 160 },
      'tools-main': { id: 'tools-main', contentComponent: 'tools-main', title: 'Tools', minimumHeight: 60, minimumWidth: 160 },
      'tools-mirror': { id: 'tools-mirror', contentComponent: 'tools-mirror', title: 'Mirror', minimumHeight: 60, minimumWidth: 160 },
      outliner: { id: 'outliner', contentComponent: 'outliner', title: 'Outliner', minimumHeight: 120, minimumWidth: 260 },
      'tools-view': { id: 'tools-view', contentComponent: 'tools-view', title: 'View', minimumHeight: 60, minimumWidth: 160 },
      'tools-gizmo': { id: 'tools-gizmo', contentComponent: 'tools-gizmo', title: 'Gizmo and snapping', minimumHeight: 60, minimumWidth: 160 },
      'tools-grid': { id: 'tools-grid', contentComponent: 'tools-grid', title: 'Grid', minimumHeight: 60, minimumWidth: 160 },
      '3d': { id: '3d', contentComponent: '3d', title: '3D', minimumHeight: 150, minimumWidth: 200 },
      front: { id: 'front', contentComponent: 'front', title: 'Front', minimumHeight: 150, minimumWidth: 200 },
      side: { id: 'side', contentComponent: 'side', title: 'Side', minimumHeight: 150, minimumWidth: 200 },
      top: { id: 'top', contentComponent: 'top', title: 'Top', minimumHeight: 150, minimumWidth: 200 },
      textures: { id: 'textures', contentComponent: 'textures', title: 'Textures' },
      models: { id: 'models', contentComponent: 'models', title: 'Models' },
      sounds: { id: 'sounds', contentComponent: 'sounds', title: 'Sounds' },
      prefabs: { id: 'prefabs', contentComponent: 'prefabs', title: 'Prefabs' },
      'tools-select': { id: 'tools-select', contentComponent: 'tools-select', title: 'Selection', minimumHeight: 60, minimumWidth: 160 },
      'tools-level': { id: 'tools-level', contentComponent: 'tools-level', title: 'Edit mode', minimumHeight: 60, minimumWidth: 160 },
      'tools-brush': { id: 'tools-brush', contentComponent: 'tools-brush', title: 'Brushes', minimumHeight: 60, minimumWidth: 160 },
      'tools-cordon': { id: 'tools-cordon', contentComponent: 'tools-cordon', title: 'Cordon', minimumHeight: 60, minimumWidth: 160 },
      tools: { id: 'tools', contentComponent: 'tools', title: 'Tool options', minimumHeight: 120, minimumWidth: 260 },
      details: { id: 'details', contentComponent: 'details', title: 'Details', minimumHeight: 120, minimumWidth: 344 },
      displacement: { id: 'displacement', contentComponent: 'displacement', title: 'Displacement', minimumHeight: 120, minimumWidth: 260 },
      figmadiff: { id: 'figmadiff', contentComponent: 'figmadiff', title: 'Figma changes', minimumHeight: 120, minimumWidth: 260 },
    },
    activeGroup: '21',
  },
  panels: ['3d', 'top', 'front', 'side', 'details', 'outliner', 'compile', 'textures', 'models', 'sounds', 'displacement', 'prefabs', 'tools', 'tools-select', 'tools-main', 'tools-gizmo', 'tools-file', 'tools-undo', 'tools-level', 'tools-grid', 'tools-brush', 'tools-edit', 'tools-mirror', 'tools-cordon', 'tools-view', 'tools-map', 'figmadiff'],
};
