import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { OpenCloudAssetsClient } from './openCloud.js';

const MAX_OBJECTS = 128;
const MAX_VERTICES = 250_000;
const MAX_FACES = 250_000;
const PRIMITIVES = new Set(['cube', 'uv_sphere', 'ico_sphere', 'cylinder', 'cone', 'torus', 'plane']);

const BLENDER_EXPORT_SCRIPT = String.raw`import bpy
import json
import math
import os

job_path = os.environ["ARENA_MESH_JOB"]
with open(job_path, "r", encoding="utf-8") as handle:
    job = json.load(handle)

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

created = []
for spec in job["objects"]:
    name = spec["name"]
    if "vertices" in spec:
        mesh = bpy.data.meshes.new(name + "Mesh")
        mesh.from_pydata(spec["vertices"], [], spec["faces"])
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
    else:
        primitive = spec["primitive"]
        if primitive == "cube":
            bpy.ops.mesh.primitive_cube_add(size=spec.get("size", 2.0))
        elif primitive == "uv_sphere":
            bpy.ops.mesh.primitive_uv_sphere_add(segments=spec.get("segments", 32), ring_count=spec.get("ringCount", 16), radius=spec.get("radius", 1.0))
        elif primitive == "ico_sphere":
            bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=spec.get("subdivisions", 2), radius=spec.get("radius", 1.0))
        elif primitive == "cylinder":
            bpy.ops.mesh.primitive_cylinder_add(vertices=spec.get("segments", 32), radius=spec.get("radius", 1.0), depth=spec.get("depth", 2.0))
        elif primitive == "cone":
            bpy.ops.mesh.primitive_cone_add(vertices=spec.get("segments", 32), radius1=spec.get("radius", 1.0), radius2=spec.get("radiusTop", 0.0), depth=spec.get("depth", 2.0))
        elif primitive == "torus":
            bpy.ops.mesh.primitive_torus_add(major_segments=spec.get("segments", 48), minor_segments=spec.get("minorSegments", 12), major_radius=spec.get("radius", 1.0), minor_radius=spec.get("minorRadius", 0.25))
        elif primitive == "plane":
            bpy.ops.mesh.primitive_plane_add(size=spec.get("size", 2.0))
        else:
            raise ValueError("Unsupported primitive: " + primitive)
        obj = bpy.context.object
        obj.name = name

    obj.location = spec.get("location", [0.0, 0.0, 0.0])
    obj.rotation_euler = [math.radians(value) for value in spec.get("rotation", [0.0, 0.0, 0.0])]
    obj.scale = spec.get("scale", [1.0, 1.0, 1.0])

    material_spec = spec.get("material")
    if material_spec:
        material = bpy.data.materials.new(name + "Material")
        material.use_nodes = True
        color = material_spec.get("color", [0.8, 0.8, 0.8, 1.0])
        material.diffuse_color = color
        shader = material.node_tree.nodes.get("Principled BSDF")
        if shader:
            shader.inputs["Base Color"].default_value = color
            shader.inputs["Metallic"].default_value = material_spec.get("metallic", 0.0)
            shader.inputs["Roughness"].default_value = material_spec.get("roughness", 0.5)
        obj.data.materials.append(material)

    if spec.get("smooth", False) and obj.type == "MESH":
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
    created.append(obj.name)

if not created:
    raise ValueError("No mesh objects were created")

bpy.ops.object.select_all(action="DESELECT")
for obj in bpy.context.scene.objects:
    if obj.name in created:
        obj.select_set(True)
bpy.context.view_layer.objects.active = bpy.data.objects[created[0]]

output = job["output"]
if job["format"] == "fbx":
    bpy.ops.export_scene.fbx(
        filepath=output,
        use_selection=True,
        apply_scale_options="FBX_SCALE_NONE",
        axis_forward="-Z",
        axis_up="Y",
        use_mesh_modifiers=True,
        add_leaf_bones=False,
        path_mode="AUTO",
    )
else:
    bpy.ops.export_scene.gltf(
        filepath=output,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_materials="EXPORT",
    )

if not os.path.isfile(output) or os.path.getsize(output) == 0:
    raise RuntimeError("Blender did not create the export")
with open(job_path + ".result", "w", encoding="utf-8") as handle:
    json.dump({"objects": created, "bytes": os.path.getsize(output)}, handle)
print("ARENA_MESH_EXPORT_OK", output)
`;

function cleanName(value, fallback) {
  const name = String(value ?? fallback).replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!name) throw new Error('Ein Mesh- und Objektname wird benötigt.');
  if (name.length > 100) throw new Error('Mesh- und Objektnamen dürfen höchstens 100 Zeichen haben.');
  return name;
}

function finite(value, fallback = 0) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || Math.abs(number) > 100_000) throw new Error('Mesh-Zahlen müssen endlich und kleiner als 100000 sein.');
  return number;
}

function vector(value, fallback, length = 3, minimum = -100_000, maximum = 100_000) {
  const input = value ?? fallback;
  if (!Array.isArray(input) || input.length !== length) throw new Error(`Erwartet wurde ein Array mit ${length} Zahlen.`);
  return input.map((entry) => {
    const number = finite(entry);
    if (number < minimum || number > maximum) throw new Error('Ein Vektorwert liegt außerhalb des erlaubten Bereichs.');
    return number;
  });
}

function positive(value, fallback, { integer = false, maximum = 10_000 } = {}) {
  const number = finite(value ?? fallback, fallback);
  if (number <= 0 || number > maximum || (integer && !Number.isInteger(number))) {
    throw new Error('Ein Mesh-Parameter ist keine gültige positive Zahl.');
  }
  return number;
}

function normalizeMaterial(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('material muss ein Objekt sein.');
  const color = vector(value.color ?? [0.8, 0.8, 0.8, 1], null, 4, 0, 1);
  return {
    color,
    metallic: Math.min(1, Math.max(0, finite(value.metallic ?? 0))),
    roughness: Math.min(1, Math.max(0, finite(value.roughness ?? 0.5))),
  };
}

export function normalizeMeshSpec(params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Mesh-Parameter müssen ein Objekt sein.');
  if (!Array.isArray(params.objects) || params.objects.length < 1 || params.objects.length > MAX_OBJECTS) {
    throw new Error(`objects muss zwischen 1 und ${MAX_OBJECTS} Mesh-Objekte enthalten.`);
  }
  const format = String(params.format ?? 'fbx').toLowerCase();
  if (!['fbx', 'glb'].includes(format)) throw new Error('format muss "fbx" oder "glb" sein.');
  let vertexCount = 0;
  let faceCount = 0;
  const usedNames = new Set();

  const objects = params.objects.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`objects[${index}] ist ungültig.`);
    const name = cleanName(input.name, `Mesh ${index + 1}`);
    if (usedNames.has(name)) throw new Error(`Der Objektname "${name}" ist doppelt vorhanden.`);
    usedNames.add(name);
    const output = {
      name,
      location: vector(input.location, [0, 0, 0]),
      rotation: vector(input.rotation, [0, 0, 0]),
      scale: vector(input.scale, [1, 1, 1], 3, 0.0001, 10_000),
      smooth: input.smooth === true,
      material: normalizeMaterial(input.material),
    };

    if (input.vertices !== undefined || input.faces !== undefined) {
      if (!Array.isArray(input.vertices) || !Array.isArray(input.faces) || !input.vertices.length || !input.faces.length) {
        throw new Error(`${name}: vertices und faces werden für ein freies Mesh benötigt.`);
      }
      vertexCount += input.vertices.length;
      faceCount += input.faces.length;
      if (vertexCount > MAX_VERTICES || faceCount > MAX_FACES) throw new Error('Das Mesh überschreitet das Limit von 250000 Vertices bzw. Faces.');
      output.vertices = input.vertices.map((vertex) => vector(vertex, null));
      output.faces = input.faces.map((face) => {
        if (!Array.isArray(face) || face.length < 3 || face.length > 64) throw new Error(`${name}: Faces benötigen 3 bis 64 Vertex-Indizes.`);
        return face.map((vertexIndex) => {
          if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= output.vertices.length) {
            throw new Error(`${name}: Ein Face verweist auf einen ungültigen Vertex-Index.`);
          }
          return vertexIndex;
        });
      });
    } else {
      const primitive = String(input.primitive ?? 'cube').toLowerCase();
      if (!PRIMITIVES.has(primitive)) throw new Error(`${name}: Unbekanntes Primitive "${primitive}".`);
      output.primitive = primitive;
      if (['cube', 'plane'].includes(primitive)) output.size = positive(input.size, 2);
      if (['uv_sphere', 'ico_sphere', 'cylinder', 'cone', 'torus'].includes(primitive)) output.radius = positive(input.radius, 1);
      if (['cylinder', 'cone'].includes(primitive)) output.depth = positive(input.depth, 2);
      if (primitive === 'cone') output.radiusTop = Math.max(0, finite(input.radiusTop ?? 0));
      if (primitive === 'torus') output.minorRadius = positive(input.minorRadius, 0.25);
      if (['uv_sphere', 'cylinder', 'cone', 'torus'].includes(primitive)) output.segments = positive(input.segments, primitive === 'torus' ? 48 : 32, { integer: true, maximum: 256 });
      if (primitive === 'uv_sphere') output.ringCount = positive(input.ringCount, 16, { integer: true, maximum: 128 });
      if (primitive === 'ico_sphere') output.subdivisions = positive(input.subdivisions, 2, { integer: true, maximum: 6 });
      if (primitive === 'torus') output.minorSegments = positive(input.minorSegments, 12, { integer: true, maximum: 128 });
    }
    return output;
  });

  return {
    name: cleanName(params.name, 'Arena Mesh'),
    description: String(params.description ?? 'Mit Arena AI und Blender erstellt').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 1000),
    format,
    upload: params.upload !== false,
    objects,
  };
}

function candidateBlenderPaths() {
  const candidates = [];
  if (process.env.BLENDER_PATH) candidates.push(process.env.BLENDER_PATH);
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const foundation = path.join(programFiles, 'Blender Foundation');
    try {
      const installations = fs.readdirSync(foundation, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const installation of installations) candidates.push(path.join(foundation, installation, 'blender.exe'));
    } catch { /* Blender is optional. */ }
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'blender.exe'));
  } else {
    candidates.push('/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender');
  }
  return candidates;
}

function findBlender(configuredPath) {
  const configured = String(configuredPath ?? '').trim();
  if (configured) {
    if (fs.existsSync(configured) && fs.statSync(configured).isFile()) return configured;
    throw new Error(`Blender wurde unter "${configured}" nicht gefunden.`);
  }
  for (const candidate of candidateBlenderPaths()) {
    try { if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(lookup, ['blender'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
  if (result.status === 0) {
    const found = String(result.stdout).split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (found && fs.existsSync(found)) return found;
  }
  return null;
}

function runBlender(executable, scriptPath, jobPath, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--background', '--factory-startup', '--python-exit-code', '1', '--python', scriptPath], {
      windowsHide: true,
      env: { ...process.env, ARENA_MESH_JOB: jobPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const capture = (chunk) => { output = `${output}${chunk.toString('utf8')}`.slice(-64_000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Blender hat das Zeitlimit von 120 Sekunden überschritten.'));
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`Blender-Export fehlgeschlagen (Exit ${code ?? 'unknown'}): ${output.trim().split(/\r?\n/).slice(-12).join('\n')}`));
    });
  });
}

export class BlenderService {
  constructor({ settings, workDirectory, fetchImpl, spawnSyncImpl = spawnSync } = {}) {
    this.settings = settings;
    this.workDirectory = workDirectory;
    this.cloud = new OpenCloudAssetsClient({ getApiKey: () => settings.getApiKey(), fetchImpl });
    this.spawnSync = spawnSyncImpl;
    this.state = { status: 'starting', available: false, path: null, version: null, message: 'Blender wird gesucht …' };
    this.lastJob = null;
  }

  snapshot() {
    const config = this.settings.getBlenderConfig();
    return {
      ...this.state,
      hasApiKey: Boolean(this.settings.getApiKey()),
      creatorConfigured: Boolean(config.creatorId),
      creatorType: config.creatorType,
      creatorId: config.creatorId,
      lastJob: this.lastJob,
    };
  }

  async refreshStatus() {
    const config = this.settings.getBlenderConfig();
    try {
      const executable = findBlender(config.blenderPath);
      if (!executable) {
        this.state = {
          status: 'unavailable', available: false, path: null, version: null,
          message: 'Blender wurde nicht gefunden. Installiere Blender oder trage den Pfad zu blender.exe ein.',
        };
      } else {
        const result = this.spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
        const version = String(result.stdout ?? '').split(/\r?\n/)[0].trim() || 'Blender';
        if (result.status !== 0) throw new Error('Blender konnte nicht gestartet werden. Prüfe den eingetragenen Pfad.');
        this.state = { status: 'online', available: true, path: executable, version, message: `${version} ist bereit.` };
      }
    } catch (error) {
      this.state = { status: 'error', available: false, path: config.blenderPath || null, version: null, message: error.message };
    }
    return this.snapshot();
  }

  async createMesh(params, context = {}) {
    const spec = normalizeMeshSpec(params);
    if (!this.state.available) await this.refreshStatus();
    if (!this.state.available) throw new Error(this.state.message);
    const config = this.settings.getBlenderConfig();
    const clients = context.session?.editableClients?.() ?? [];
    const selectedClient = clients.find((client) => client.id === context.targetClientId) ?? clients[0];
    const creatorType = String(params.creatorType ?? (config.creatorId ? config.creatorType : 'user')).toLowerCase();
    const configuredCreator = creatorType === config.creatorType ? config.creatorId : '';
    const creatorId = String(params.creatorId ?? (configuredCreator || (creatorType === 'user' ? selectedClient?.accountUserId : '')) ?? '').trim();
    if (spec.upload && !['user', 'group'].includes(creatorType)) throw new Error('Creator-Typ muss "user" oder "group" sein.');
    if (spec.upload && !this.settings.getApiKey()) throw new Error('Für den Open-Cloud-Upload fehlt der API-Key. Alternativ kannst du "upload": false verwenden.');
    if (spec.upload && !creatorId) throw new Error('Trage eine Creator-ID in den Einstellungen ein oder verbinde zuerst deinen Studio-Account.');

    const jobId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const directory = path.join(this.workDirectory, jobId);
    fs.mkdirSync(directory, { recursive: true });
    const jobPath = path.join(directory, 'mesh.json');
    const scriptPath = path.join(directory, 'arena-export.py');
    const output = path.join(directory, `model.${spec.format}`);
    fs.writeFileSync(jobPath, JSON.stringify({ objects: spec.objects, format: spec.format, output }), { mode: 0o600 });
    fs.writeFileSync(scriptPath, BLENDER_EXPORT_SCRIPT, { mode: 0o600 });
    this.lastJob = { id: jobId, name: spec.name, status: 'exporting', startedAt: Date.now(), outputPath: null, assetId: null };

    try {
      await runBlender(this.state.path, scriptPath, jobPath);
      const size = fs.statSync(output).size;
      this.lastJob = { ...this.lastJob, status: spec.upload ? 'uploading' : 'completed', outputPath: output, bytes: size };
      let upload = null;
      if (spec.upload) {
        upload = await this.cloud.uploadModel({
          filePath: output,
          displayName: spec.name,
          description: spec.description,
          creatorId,
          creatorType,
        });
      }
      this.lastJob = { ...this.lastJob, status: 'completed', outputPath: output, bytes: size, assetId: upload?.assetId ?? null, completedAt: Date.now() };
      return {
        created: true,
        name: spec.name,
        format: spec.format,
        objectCount: spec.objects.length,
        bytes: size,
        outputPath: output,
        uploaded: Boolean(upload),
        ...(upload ?? {}),
        nextStep: upload ? `Verwende die Studio-Aktion insert_model mit assetId ${upload.assetId}, um das Modell in die ausgewählte Place einzufügen.` : 'Der lokale Export ist fertig. Für Roblox kannst du ihn mit upload: true erneut hochladen.',
      };
    } catch (error) {
      this.lastJob = { ...this.lastJob, status: 'error', error: error.message, completedAt: Date.now() };
      throw error;
    }
  }

  localActions() {
    return {
      get_blender_status: async () => this.refreshStatus(),
      create_blender_mesh: async (params, context) => this.createMesh(params, context),
    };
  }
}

export { BLENDER_EXPORT_SCRIPT, findBlender };
