import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import sharp from 'sharp'
import { inspectGlb, readModelFile, mediaPath } from '../creative-tools/files.js'
import {
  ENCODE,
  SAFE_INPUT,
  choice,
  dimensions,
  duration,
  ffmpeg,
  inferKind,
  inputUrl,
  inside,
  jsonResult,
  list,
  media,
  num,
  object,
  output,
  probe,
  result,
  run,
  str,
} from './local-core.js'
import type { LocalContext, LocalDependencies, ToolResult } from './local-core.js'
import { writeZip } from './local-graphics.js'
import { renderThreeFrames, productionBrowser } from './browser-render.js'

const python = () => process.env.PRODUCTION_PYTHON_BIN || 'python3'
const blender = () =>
  process.env.BLENDER_BIN ||
  (process.platform === 'darwin' ? '/Applications/Blender.app/Contents/MacOS/Blender' : 'blender')
const rembg = () => process.env.REMBG_BIN || 'rembg'
const availabilityCache = new Map<string, { time: number; result: { available: boolean; reason?: string } }>()
function commandAvailable(binary: string, args: string[], timeout = 10000): Promise<boolean> {
  return new Promise((resolve) =>
    execFile(binary, args, { timeout, maxBuffer: 65536, windowsHide: true }, (error) => resolve(!error)),
  )
}
async function fileAvailable(file: string) {
  return !!(await fs.stat(file).catch(() => null))?.isFile()
}
function threeRoot() {
  const req = createRequire(import.meta.url)
  try {
    return path.dirname(path.dirname(req.resolve('three')))
  } catch {
    const packageFile = path.resolve(
      import.meta.dirname,
      '../../../../frontend-react/node_modules/three/package.json',
    )
    return path.dirname(packageFile)
  }
}

export async function localToolAvailability(
  toolId: string,
): Promise<{ available: boolean; reason?: string }> {
  const cached = availabilityCache.get(toolId)
  if (cached && Date.now() - cached.time < 30000) return cached.result
  let value: { available: boolean; reason?: string } = { available: true }
  if (toolId === 'blender_world' && !(await commandAvailable(blender(), ['--version'])))
    value = { available: false, reason: '需要安装 Blender 4.x，并通过 BLENDER_BIN 配置可执行文件' }
  if (toolId === 'threejs_world' && !(await fileAvailable(path.join(threeRoot(), 'build/three.module.js'))))
    value = { available: false, reason: '需要安装 three 包（前端依赖或后端依赖）以导出离线场景' }
  if (toolId === 'threejs_world' && value.available) {
    try {
      await productionBrowser()
    } catch {
      value = {
        available: false,
        reason: '三维视频渲染需要 Chrome / Chromium，请安装浏览器或设置 PRODUCTION_CHROME_BIN',
      }
    }
  }
  if (
    toolId === 'face_tracker' &&
    !(await commandAvailable(python(), ['-c', 'import cv2; assert cv2.data.haarcascades']))
  )
    value = { available: false, reason: '需要给 PRODUCTION_PYTHON_BIN 对应的 Python 安装 opencv-python' }
  if (toolId === 'bg_remove' && !(await commandAvailable(rembg(), ['--help'])))
    value = { available: false, reason: '需要安装 rembg CLI 和分割模型，并通过 REMBG_BIN 配置命令' }
  if (toolId === 'face_restore') {
    const root = process.env.GFPGAN_ROOT
    if (
      !(
        root &&
        (await fileAvailable(path.join(root, 'inference_gfpgan.py'))) &&
        ((await fileAvailable(path.join(root, 'experiments/pretrained_models/GFPGANv1.4.pth'))) ||
          (await fileAvailable(path.join(root, 'gfpgan/weights/GFPGANv1.4.pth'))))
      )
    )
      value = {
        available: false,
        reason: '需要安装 GFPGAN、GFPGANv1.4.pth 权重并配置 GFPGAN_ROOT，以及匹配的 PRODUCTION_PYTHON_BIN',
      }
    else if (!(await commandAvailable(python(), ['-c', 'import torch,cv2'])))
      value = {
        available: false,
        reason: 'GFPGAN 使用的 PRODUCTION_PYTHON_BIN 需要 PyTorch 和 opencv-python 运行依赖',
      }
  }
  availabilityCache.set(toolId, { time: Date.now(), result: value })
  return value
}
async function requireDependency(toolId: string) {
  const available = await localToolAvailability(toolId)
  if (!available.available) throw new Error(available.reason)
}

async function background(ctx: LocalContext, deps: LocalDependencies) {
  const source = await media(ctx, deps, inputUrl(ctx.args), 'image')
  await requireDependency('bg_remove')
  const model = choice(ctx.args, 'model', ['u2net', 'u2net_human_seg', 'isnet-general-use'] as const, 'u2net')
  await run(ctx, rembg(), ['i', '-m', model, source, output(ctx, 'image.png')], { timeout: 600000 })
  if (ctx.args.bg_color) {
    const value = str(ctx.args, 'bg_color', '', 7)
    if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error('背景色须为 #RRGGBB')
    await sharp(output(ctx, 'image.png'))
      .flatten({ background: value })
      .png()
      .toFile(output(ctx, 'background.png'))
    return result(ctx, '背景分割与替换完成', [
      ['image.png', 'image'],
      ['background.png', 'image'],
    ])
  }
  const metadata = await sharp(output(ctx, 'image.png')).metadata()
  if (!metadata.hasAlpha) throw new Error('分割服务未输出透明通道')
  return result(ctx, '背景分割完成', [['image.png', 'image']], { model, alpha: true })
}

const FACE_SCRIPT = `import cv2,json,sys,math
spec=json.load(open(sys.argv[1],encoding='utf8'))
detector=cv2.CascadeClassifier(cv2.data.haarcascades+'haarcascade_frontalface_default.xml')
if detector.empty(): raise RuntimeError('OpenCV face model unavailable')
cap=cv2.VideoCapture(spec['input'])
if not cap.isOpened(): raise RuntimeError('Cannot open source video')
fps=cap.get(cv2.CAP_PROP_FPS); frame_count=cap.get(cv2.CAP_PROP_FRAME_COUNT)
if fps<=0: raise RuntimeError('Invalid video fps')
duration=frame_count/fps
results=[]; previous=[]; serial=0
for index in range(min(600,math.ceil(duration*spec['sample_fps']))):
 t=index/spec['sample_fps'];cap.set(cv2.CAP_PROP_POS_MSEC,t*1000);ok,frame=cap.read()
 if not ok: break
 h,w=frame.shape[:2]; factor=min(1.0,960/w); small=cv2.resize(frame,(int(w*factor),int(h*factor)))
 boxes=detector.detectMultiScale(cv2.cvtColor(small,cv2.COLOR_BGR2GRAY),scaleFactor=1.12,minNeighbors=5,minSize=(24,24))
 faces=[]; used=set()
 for x,y,bw,bh in boxes[:20]:
  x=float(x)/factor;y=float(y)/factor;bw=float(bw)/factor;bh=float(bh)/factor;cx=x+bw/2;cy=y+bh/2
  matches=[(math.hypot(p['x']+p['width']/2-cx,p['y']+p['height']/2-cy),p) for p in previous if p['id'] not in used]
  matches.sort(key=lambda a:a[0]);match=matches[0] if matches else None
  if match and match[0]<max(bw,bh): ident=match[1]['id']
  else: serial+=1;ident=serial
  used.add(ident);faces.append(dict(id=ident,x=round(x,2),y=round(y,2),width=round(bw,2),height=round(bh,2),focus_x=round(cx/w,4)))
 results.append(dict(time=round(t,4),faces=faces));previous=faces
cap.release()
json.dump(dict(method='opencv-haar-centroid',duration=duration,sample_fps=spec['sample_fps'],frames=results),open(spec['output'],'w',encoding='utf8'))
`
async function faceTrack(ctx: LocalContext, deps: LocalDependencies) {
  const source = await media(ctx, deps, inputUrl(ctx.args), 'video')
  await requireDependency('face_tracker')
  const info = await probe(ctx, deps, source),
    seconds = duration(info),
    sample = num(ctx.args, 'sample_fps', Math.min(5, 600 / seconds), 0.05, Math.min(10, 600 / seconds))
  await fs.writeFile(output(ctx, 'face-runtime.py'), FACE_SCRIPT)
  await fs.writeFile(
    output(ctx, 'face-input.json'),
    JSON.stringify({ input: source, output: output(ctx, 'tracking.json'), sample_fps: sample }),
  )
  await run(ctx, python(), [output(ctx, 'face-runtime.py'), output(ctx, 'face-input.json')], {
    timeout: 600000,
  })
  const data = JSON.parse(await fs.readFile(output(ctx, 'tracking.json'), 'utf8')) as Record<string, unknown>
  return result(ctx, '人脸位置追踪完成', [['tracking.json', 'data']], data)
}
async function restore(ctx: LocalContext, deps: LocalDependencies) {
  const source = await media(ctx, deps, inputUrl(ctx.args), 'image')
  await requireDependency('face_restore')
  if (ctx.args.model && ctx.args.model !== 'GFPGAN')
    throw new Error('当前本地修复适配器使用 GFPGAN，请将 model 设为 GFPGAN')
  const factor = Math.round(num(ctx.args, 'upscale', 2, 1, 4)),
    root = process.env.GFPGAN_ROOT!,
    directory = path.join(ctx.outputDir, 'restored')
  await fs.mkdir(directory, { recursive: true })
  await run(
    ctx,
    python(),
    [
      path.join(root, 'inference_gfpgan.py'),
      '-i',
      source,
      '-o',
      directory,
      '-v',
      '1.4',
      '-s',
      String(factor),
      '--bg_upsampler',
      '',
    ],
    { timeout: 600000, cwd: root },
  )
  const generated = path.join(directory, 'restored_imgs', `${path.parse(source).name}.png`),
    resolved = await fs.realpath(generated)
  if (!inside(await fs.realpath(ctx.outputDir), resolved)) throw new Error('人脸修复输出目录无效')
  await fs.copyFile(resolved, output(ctx, 'image.png'))
  return result(ctx, '人脸修复完成', [['image.png', 'image']], { model: 'GFPGAN-1.4', upscale: factor })
}

interface WorldObject {
  type: 'box' | 'sphere' | 'cone' | 'tree'
  x: number
  y: number
  z: number
  size: number
  color: string
}
function worldSpec(ctx: LocalContext) {
  const raw = ctx.args.world_spec ? object(ctx.args.world_spec) : ctx.args,
    objects = list(raw, 'objects', 200).map((value) => {
      const item = object(value),
        color = str(item, 'color', '#79a8df', 7)
      if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('物体颜色须为 #RRGGBB')
      return {
        type: choice(item, 'type', ['box', 'sphere', 'cone', 'tree'] as const, 'box'),
        x: num(item, 'x', 0, -1000, 1000),
        y: num(item, 'y', 0, -1000, 1000),
        z: num(item, 'z', 0, -1000, 1000),
        size: num(item, 'size', 1, 0.05, 100),
        color,
      }
    })
  if (!objects.length && !list(ctx.args, 'model_urls', 10).length)
    throw new Error('请在 world_spec.objects 中提供场景物体，或选择当前项目的 GLB 模型')
  const points = list(raw, 'camera_path', 50).map((value) => {
    const point = object(value)
    return {
      x: num(point, 'x', 8, -1000, 1000),
      y: num(point, 'y', 5, -1000, 1000),
      z: num(point, 'z', 8, -1000, 1000),
      targetX: num(point, 'targetX', 0, -1000, 1000),
      targetY: num(point, 'targetY', 0, -1000, 1000),
      targetZ: num(point, 'targetZ', 0, -1000, 1000),
    }
  })
  return {
    title: str(raw, 'title', '三维场景', 100),
    objects,
    camera_path: points.length
      ? points.length === 1
        ? [points[0], points[0]]
        : points
      : [
          { x: 8, y: 5, z: 8, targetX: 0, targetY: 0, targetZ: 0 },
          { x: -8, y: 5, z: 8, targetX: 0, targetY: 0, targetZ: 0 },
        ],
    groundSize: num(raw, 'groundSize', 40, 1, 2000),
    duration: num(ctx.args, 'duration_seconds', 5, 0.1, 30),
    ...dimensions(ctx.args, 960, 540),
    fps: Math.round(num(ctx.args, 'fps', 12, 1, 30)),
  }
}
const THREE_RUNTIME = `import * as THREE from './three.module.js';
import { GLTFLoader } from './GLTFLoader.js';
const spec=await fetch('./world.json').then(r=>r.json());
const scene=new THREE.Scene();scene.background=new THREE.Color(0x152338);scene.fog=new THREE.Fog(0x152338,30,180);
const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setSize(innerWidth,innerHeight);renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.shadowMap.enabled=true;document.body.appendChild(renderer.domElement);
const camera=new THREE.PerspectiveCamera(48,innerWidth/innerHeight,.05,3000),ambient=new THREE.HemisphereLight(0xdbeaff,0x62704c,2);scene.add(ambient);
const sun=new THREE.DirectionalLight(0xfff1d1,3);sun.position.set(12,20,10);sun.castShadow=true;scene.add(sun);
const ground=new THREE.Mesh(new THREE.PlaneGeometry(spec.groundSize,spec.groundSize),new THREE.MeshStandardMaterial({color:0x63764a,roughness:.9}));ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;scene.add(ground);
for(const item of spec.objects){const mat=new THREE.MeshStandardMaterial({color:item.color,roughness:.65});let geo=item.type==='sphere'?new THREE.SphereGeometry(item.size/2,32,16):item.type==='cone'||item.type==='tree'?new THREE.ConeGeometry(item.size/2,item.size,16):new THREE.BoxGeometry(item.size,item.size,item.size);const mesh=new THREE.Mesh(geo,mat);mesh.position.set(item.x,item.y+item.size/2,item.z);mesh.castShadow=true;mesh.receiveShadow=true;scene.add(mesh);if(item.type==='tree'){const trunk=new THREE.Mesh(new THREE.CylinderGeometry(item.size*.07,item.size*.1,item.size,8),new THREE.MeshStandardMaterial({color:0x795238}));trunk.position.set(item.x,item.y,item.z);scene.add(trunk);}}
const mixers=[];const loader=new GLTFLoader();
for(const entry of spec.models??[]){const gltf=await loader.loadAsync('./'+entry.file);const content=gltf.scene;const box=new THREE.Box3().setFromObject(content),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());const factor=2.8/Math.max(size.y,size.x,size.z,.001);const placement=new THREE.Group();placement.scale.setScalar(factor);placement.position.set(entry.x-center.x*factor,-box.min.y*factor,-center.z*factor);placement.add(content);content.traverse(item=>{if(item.isMesh){item.castShadow=true;item.receiveShadow=true;}});scene.add(placement);if(gltf.animations.length){const mixer=new THREE.AnimationMixer(content);mixer.clipAction(gltf.animations[0]).play();mixers.push(mixer);}}
const range=new THREE.Box3();scene.updateMatrixWorld();range.setFromObject(ground);
let playing=true,elapsed=0,last=performance.now();document.querySelector('button').onclick=()=>{playing=!playing;document.querySelector('button').textContent=playing?'暂停':'播放';};
function draw(time){for(const mixer of mixers)mixer.setTime(time);const position=Math.min(.999999,Math.max(0,time/spec.duration))*(spec.camera_path.length-1),i=Math.floor(position),a=spec.camera_path[i],b=spec.camera_path[Math.min(i+1,spec.camera_path.length-1)],t=position-i;camera.position.set(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,a.z+(b.z-a.z)*t);camera.lookAt(a.targetX+(b.targetX-a.targetX)*t,a.targetY+(b.targetY-a.targetY)*t,a.targetZ+(b.targetZ-a.targetZ)*t);renderer.render(scene,camera);}
globalThis.__renderFrame=time=>{playing=false;elapsed=time;document.querySelector('button').style.display='none';draw(time);return renderer.domElement.toDataURL('image/png').split(',')[1];};
function render(now){const delta=Math.max(0,now-last)/1000;last=now;if(playing)elapsed=(elapsed+delta)%spec.duration;draw(elapsed);requestAnimationFrame(render);}requestAnimationFrame(render);
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
`
async function worldModels(ctx: LocalContext) {
  const urls = list(ctx.args, 'model_urls', 10)
  const models: {
    file: string
    sourceUrl: string
    x: number
    meshes: number
    joints: number
    animations: number
  }[] = []
  let total = 0
  for (const [index, value] of urls.entries()) {
    if (
      typeof value !== 'string' ||
      !value.startsWith(`/static/creative/${ctx.projectId}/`) ||
      !/\.glb$/.test(value) ||
      /[\\%?#:\x00-\x1f]/.test(value) ||
      value.includes('..')
    )
      throw new Error('三维模型须为当前项目内已上传的 GLB 文件')
    const stat = await fs.stat(mediaPath(value))
    if (!stat.isFile() || stat.size > 50 * 1024 * 1024 || total + stat.size > 100 * 1024 * 1024)
      throw new Error('单个 GLB 模型最多 50MB，场景模型总计最多 100MB')
    const bytes = await readModelFile(ctx.projectId, value)
    total += bytes.length
    if (bytes.length > 50 * 1024 * 1024 || total > 100 * 1024 * 1024)
      throw new Error('单个 GLB 模型最多 50MB，场景模型总计最多 100MB')
    const details = inspectGlb(bytes)
    const file = `model-${index}.glb`
    await fs.writeFile(output(ctx, file), bytes)
    models.push({ file, sourceUrl: value, x: (index - (urls.length - 1) / 2) * 3.2, ...details })
  }
  return models
}
async function writeThreeModules(ctx: LocalContext) {
  const modules = {
    GLTFLoader: 'loaders/GLTFLoader.js',
    BufferGeometryUtils: 'utils/BufferGeometryUtils.js',
    SkeletonUtils: 'utils/SkeletonUtils.js',
  }
  const names: string[] = []
  for (const [name, relative] of Object.entries(modules)) {
    const content = (await fs.readFile(path.join(threeRoot(), 'examples/jsm', relative), 'utf8'))
      .replace(/from ['"]three['"]/g, "from './three.module.js'")
      .replace(/from ['"]\.\.\/utils\/(BufferGeometryUtils|SkeletonUtils)\.js['"]/g, "from './$1.js'")
    await fs.writeFile(output(ctx, `${name}.js`), content)
    names.push(`${name}.js`)
  }
  return names
}
async function threeWorld(ctx: LocalContext, deps: LocalDependencies) {
  const models = await worldModels(ctx)
  const spec = { ...worldSpec(ctx), models }
  if (ctx.args.operation === 'validate')
    return jsonResult(ctx, '三维场景参数检查通过', {
      valid: true,
      objectCount: spec.objects.length,
      cameraPoints: spec.camera_path.length,
      models,
    })
  await requireDependency('threejs_world')
  await fs.writeFile(output(ctx, 'world.json'), JSON.stringify(spec, null, 2))
  await fs.writeFile(output(ctx, 'world.js'), THREE_RUNTIME)
  await fs.writeFile(
    output(ctx, 'world.html'),
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>视频工厂 · 三维场景</title><style>body{margin:0;overflow:hidden;background:#152338}button{position:fixed;z-index:1;left:16px;top:16px;background:#20334d;color:white;border:1px solid #6287ba;border-radius:8px;padding:10px 16px}</style><button>暂停</button><script type="module" src="./world.js"></script></html>',
  )
  const names = ['world.html', 'world.js', 'world.json', 'three.module.js', 'three.core.js']
  for (const name of names.slice(3))
    await fs.copyFile(path.join(threeRoot(), 'build', name), output(ctx, name))
  names.push(...(await writeThreeModules(ctx)), ...models.map((model) => model.file))
  const license = await fs.readFile(path.join(threeRoot(), 'LICENSE'))
  await fs.writeFile(output(ctx, 'LICENSE.txt'), license)
  await fs.writeFile(
    output(ctx, 'README.txt'),
    '解压后使用静态文件服务器打开 world.html，可播放、暂停摄像机轨迹。Three.js 使用 MIT 协议，完整声明见 LICENSE.txt。场景对象和镜头参数位于 world.json。\n',
  )
  names.push('LICENSE.txt', 'README.txt')
  await writeZip(
    output(ctx, 'world.zip'),
    names.map((name) => ({ name, file: output(ctx, name) })),
    ctx.signal,
  )
  if (ctx.args.render_video) {
    await renderThreeFrames(ctx, spec)
    await fs.copyFile(output(ctx, 'three-frame-00000.png'), output(ctx, 'image.png'))
    await ffmpeg(ctx, deps, [
      '-framerate',
      String(spec.fps),
      '-i',
      path.join(ctx.outputDir, 'three-frame-%05d.png'),
      ...ENCODE,
      '-an',
      '-t',
      String(spec.duration),
      output(ctx, 'world.mp4'),
    ])
    return result(
      ctx,
      '三维场景与镜头视频已渲染',
      [
        ['world.mp4', 'video'],
        ['image.png', 'image'],
        ['world.zip', 'archive'],
        ['world.json', 'data'],
      ],
      { runtime: 'threejs', objects: spec.objects.length, models, rendered: true },
    )
  }
  return result(
    ctx,
    '可交互的三维场景已生成',
    [
      ['world.zip', 'archive'],
      ['world.html', 'data'],
      ['world.json', 'data'],
    ],
    { objects: spec.objects.length, models, runtime: 'threejs', requiresStaticServer: true },
  )
}

const BLENDER_RUNTIME = `import bpy,json,sys,math
from mathutils import Vector
spec=json.load(open(sys.argv[sys.argv.index('--')+1],encoding='utf8'))
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
scene=bpy.context.scene;scene.render.engine='BLENDER_EEVEE_NEXT';scene.render.resolution_x=spec['width'];scene.render.resolution_y=spec['height'];scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG';scene.render.fps=spec['fps'];scene.world.color=(.12,.16,.22)
def material(color):
 m=bpy.data.materials.new(color);m.diffuse_color=tuple(int(color[i:i+2],16)/255 for i in (1,3,5))+(1,);m.use_nodes=True;m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=m.diffuse_color;return m
bpy.ops.mesh.primitive_plane_add(size=spec['groundSize']);ground=bpy.context.object;ground.data.materials.append(material('#63764a'))
for item in spec['objects']:
 loc=(item['x'],item['z'],item['y']+item['size']/2)
 if item['type']=='sphere':bpy.ops.mesh.primitive_uv_sphere_add(radius=item['size']/2,location=loc)
 elif item['type'] in ['cone','tree']:bpy.ops.mesh.primitive_cone_add(radius1=item['size']/2,depth=item['size'],location=loc)
 else:bpy.ops.mesh.primitive_cube_add(size=item['size'],location=loc)
 bpy.context.object.data.materials.append(material(item['color']))
 if item['type']=='tree':bpy.ops.mesh.primitive_cylinder_add(radius=item['size']*.08,depth=item['size'],location=(item['x'],item['z'],item['y']));bpy.context.object.data.materials.append(material('#795238'))
for entry in spec.get('models',[]):
 before=set(bpy.data.objects);bpy.ops.import_scene.gltf(filepath=spec['directory']+'/'+entry['file']);imported=[obj for obj in bpy.data.objects if obj not in before];roots=[obj for obj in imported if obj.parent is None]
 bpy.context.view_layer.update();coords=[obj.matrix_world@Vector(corner) for obj in imported if obj.type=='MESH' for corner in obj.bound_box]
 if coords:
  minimum=Vector(tuple(min(v[i] for v in coords) for i in range(3)));maximum=Vector(tuple(max(v[i] for v in coords) for i in range(3)));extent=maximum-minimum;factor=2.8/max(extent.x,extent.y,extent.z,.001);center=(minimum+maximum)/2
 else:factor=1;minimum=Vector((0,0,0));center=Vector((0,0,0))
 placement=bpy.data.objects.new('VideoFactoryModel',None);scene.collection.objects.link(placement);placement.scale=(factor,factor,factor);placement.location=(entry['x']-center.x*factor,-center.y*factor,-minimum.z*factor)
 for obj in roots:obj.parent=placement
bpy.ops.object.light_add(type='AREA',location=(8,-6,16));bpy.context.object.data.energy=1800;bpy.context.object.data.shape='DISK';bpy.context.object.data.size=12
bpy.ops.object.camera_add();camera=bpy.context.object;camera.data.lens=42;scene.camera=camera
for i,point in enumerate(spec['camera_path']):
 frame=round(i/(len(spec['camera_path'])-1)*max(1,math.ceil(spec['duration']*spec['fps'])-1));camera.location=(point['x'],point['z'],point['y']);target=Vector((point['targetX'],point['targetZ'],point['targetY']));camera.rotation_euler=(target-camera.location).to_track_quat('-Z','Y').to_euler();camera.keyframe_insert(data_path='location',frame=frame);camera.keyframe_insert(data_path='rotation_euler',frame=frame)
scene.frame_start=0;scene.frame_end=max(1,math.ceil(spec['duration']*spec['fps']))-1;bpy.ops.wm.save_as_mainfile(filepath=spec['blend'])
for i in range(scene.frame_end+1 if spec['animate'] else 1):
 scene.frame_set(i);scene.render.filepath=spec['directory']+'/render-'+str(i).zfill(4)+'.png';bpy.ops.render.render(write_still=True)
`
async function blenderWorld(ctx: LocalContext, deps: LocalDependencies) {
  const models = await worldModels(ctx)
  const spec = { ...worldSpec(ctx), models }
  await requireDependency('blender_world')
  if (spec.duration * spec.fps > 450) throw new Error('Blender 本地渲染最多 450 帧，请缩短时长或降低帧率')
  await fs.writeFile(output(ctx, 'blender-runtime.py'), BLENDER_RUNTIME)
  await fs.writeFile(
    output(ctx, 'world.json'),
    JSON.stringify({
      ...spec,
      blend: output(ctx, 'world.blend'),
      directory: ctx.outputDir,
      animate: ctx.args.render_video !== false,
    }),
  )
  await run(
    ctx,
    blender(),
    [
      '--background',
      '--factory-startup',
      '--disable-autoexec',
      '--python',
      output(ctx, 'blender-runtime.py'),
      '--',
      output(ctx, 'world.json'),
    ],
    { timeout: 1800000 },
  )
  await fs.copyFile(output(ctx, 'render-0000.png'), output(ctx, 'image.png'))
  if (ctx.args.render_video === false)
    return result(ctx, 'Blender 场景与预览图已生成', [
      ['world.blend', 'model'],
      ['image.png', 'image'],
    ])
  await ffmpeg(ctx, deps, [
    '-framerate',
    String(spec.fps),
    '-i',
    path.join(ctx.outputDir, 'render-%04d.png'),
    ...ENCODE,
    '-movflags',
    '+faststart',
    output(ctx, 'video.mp4'),
  ])
  return result(ctx, 'Blender 场景和镜头视频已渲染', [
    ['world.blend', 'model'],
    ['image.png', 'image'],
    ['video.mp4', 'video'],
  ])
}

async function catalog(ctx: LocalContext, deps: LocalDependencies) {
  const urls = list(ctx.args, 'sourceUrls', 100),
    items = []
  if (!urls.length) throw new Error('请先上传 GLB 模型，并提供 sourceUrls')
  for (const url of urls) {
    if (
      typeof url !== 'string' ||
      !url.startsWith(`/static/creative/${ctx.projectId}/`) ||
      !/\.glb$/i.test(url) ||
      /[\\%?#:\x00-\x1f]/.test(url) ||
      url.includes('..')
    )
      throw new Error('模型目录须属于当前项目')
    const root = await fs.realpath(deps.root),
      source = await fs.realpath(path.resolve(root, url.slice('/static/'.length)))
    if (!inside(path.join(root, 'creative', String(ctx.projectId)), source))
      throw new Error('模型路径超出当前项目')
    const bytes = await fs.readFile(source)
    if (bytes.length > 50 * 1024 * 1024) throw new Error('GLB 模型超过 50 MB')
    const details = inspectGlb(bytes)
    items.push({ sourceUrl: url, name: path.basename(source), bytes: bytes.length, ...details })
  }
  return jsonResult(ctx, '三维资产清单已建立', {
    items,
    license: str(ctx.args, 'license', '用户提供；发布前确认授权', 300),
    attribution: str(ctx.args, 'attribution', '', 2000),
  })
}

async function capture(ctx: LocalContext, deps: LocalDependencies) {
  const operation = str(ctx.args, 'operation', ctx.toolId === 'cap_recorder' ? 'detect' : 'record', 50)
  if (ctx.toolId === 'cap_recorder' || operation === 'recommend') {
    const installed =
      process.platform === 'darwin' &&
      !!(await fs.stat('/Applications/Cap.app').catch(() => null))?.isDirectory()
    return jsonResult(ctx, '录屏环境检查完成', {
      platform: process.platform,
      capInstalled: installed,
      recordingSupported: ['darwin', 'win32', 'linux'].includes(process.platform),
      guidance: '可使用系统录屏或 Cap 录制后上传；自动录屏会在系统授权后执行，录制前请确认目标屏幕和时长。',
      supportedOperations: ['detect', 'status', 'setup_guide'],
    })
  }
  if (operation !== 'record') throw new Error('录屏支持 record；已有录像请先通过素材库上传')
  const seconds = num(ctx.args, 'duration_seconds', 10, 1, 600),
    fps = Math.round(num(ctx.args, 'fps', 30, 1, 60)),
    index = Math.round(num(ctx.args, 'screen_index', 1, 0, 20)),
    audio = ctx.args.capture_audio === true
  if (audio) throw new Error('自动录屏当前只采集画面，系统音频请使用 Cap 录制后上传，避免设备映射不明确')
  let input: string[]
  if (process.platform === 'darwin')
    input = ['-f', 'avfoundation', '-framerate', String(fps), '-capture_cursor', '1', '-i', `${index}:none`]
  else if (process.platform === 'win32') input = ['-f', 'gdigrab', '-framerate', String(fps), '-i', 'desktop']
  else if (process.platform === 'linux') {
    const display = process.env.DISPLAY
    if (!display || !/^:\d+(?:\.\d+)?$/.test(display))
      throw new Error('Linux 自动录屏需要可用的 X11 DISPLAY；Wayland 请使用系统录屏后上传')
    input = ['-f', 'x11grab', '-framerate', String(fps), '-i', display]
  } else throw new Error('当前系统不支持自动录屏，请录制后上传素材')
  const filters: string[] = []
  if (ctx.args.region) {
    const region = object(ctx.args.region),
      x = Math.round(num(region, 'x', 0, 0, 10000)),
      y = Math.round(num(region, 'y', 0, 0, 10000)),
      width = Math.round(num(region, 'width', 1280, 64, 3840) / 2) * 2,
      height = Math.round(num(region, 'height', 720, 64, 3840) / 2) * 2
    filters.push('-vf', `crop=${width}:${height}:${x}:${y}`)
  }
  await ffmpeg(
    ctx,
    deps,
    [
      ...input,
      '-t',
      String(seconds),
      ...filters,
      ...ENCODE,
      '-movflags',
      '+faststart',
      output(ctx, 'video.mp4'),
    ],
    (seconds + 30) * 1000,
  )
  const info = await probe(ctx, deps, output(ctx, 'video.mp4'))
  if (!info.streams?.some((s) => s.codec_type === 'video'))
    throw new Error('没有采集到屏幕画面，请检查系统录屏权限和 screen_index')
  return result(ctx, '屏幕录制完成', [['video.mp4', 'video']], {
    duration: duration(info),
    platform: process.platform,
  })
}

export async function runAdapterTool(ctx: LocalContext, deps: LocalDependencies): Promise<ToolResult | null> {
  switch (ctx.toolId) {
    case 'bg_remove':
      return background(ctx, deps)
    case 'face_tracker':
      return faceTrack(ctx, deps)
    case 'face_restore':
      return restore(ctx, deps)
    case 'threejs_world':
      return threeWorld(ctx, deps)
    case 'blender_world':
      return blenderWorld(ctx, deps)
    case 'threejs_asset_catalog':
      return catalog(ctx, deps)
    case 'screen_recorder':
    case 'screen_capture_selector':
    case 'cap_recorder':
      return capture(ctx, deps)
    default:
      return null
  }
}
