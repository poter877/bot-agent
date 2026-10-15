import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// A real executable at the Docker boundary: production spawn/stdin/limits are exercised.
const DOCKER = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = path.dirname(process.argv[1]);
const file = path.join(root, 'state.json');
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(path.join(root, 'trace.jsonl'), JSON.stringify({args,input})+'\\n');
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const out = value => console.log(typeof value === 'string' ? value : JSON.stringify(value));
const fail = message => { console.error(message); process.exit(1); };
const labels = {};
args.forEach((arg,i) => { if(arg==='--label') { const value=args[i+1]; const at=value.indexOf('='); labels[value.slice(0,at)]=value.slice(at+1); } });
const last = args[args.length-1];
if(state.unavailable) fail('Cannot connect to the Docker daemon');
if(args[0]==='network') out([{Driver:'bridge',EnableIPv6:false,Labels:state.policy?{'bot.cloud.network-policy':'restricted-v1'}:{},Options:{'com.docker.network.bridge.enable_icc':'false','com.docker.network.bridge.name':'br-bot-cloud'}}]);
else if(args[0]==='image') out([{}]);
else if(args[0]==='inspect') { const item=state.containers[last]; if(!item) fail('Error: No such object: '+last); out([item]); }
else if(args[0]==='volume') {
  if(args[1]==='create') { state.volumes[last] ??= {Labels:labels}; save(); out(last); }
  else out([state.volumes[last]]);
}
else if(args[0]==='ps') {
  const owner = args.find(arg=>arg.startsWith('label=bot.cloud.owner='))?.split('=').slice(2).join('=');
  out(Object.entries(state.containers).filter(([name,item])=>(args.includes('-a') || item.State.Running) && (!owner || item.Config.Labels['bot.cloud.owner']===owner)).map(([name])=>name).join('\\n'));
}
else if(args[0]==='create') {
  const name=args[args.indexOf('--name')+1]; if(state.containers[name]) fail('container name conflict');
  const network=args[args.indexOf('--network')+1];
  state.containers[name]={Config:{Labels:labels},State:{Running:false},HostConfig:{NetworkMode:network,Privileged:false,ReadonlyRootfs:args.includes('--read-only')},NetworkSettings:{Networks:{[network]:{}}}};
  save(); out(name);
}
else if(args[0]==='start' || args[0]==='stop') {
  state.containers[last].State.Running=args[0]==='start'; save(); out(last);
}
else if(args[0]==='exec') {
  const command=JSON.parse(input);
  const respond=()=>out(command.action==='screenshot' ? {image:{mediaType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',width:1,height:1}} : {ok:true});
  if(command.action==='type' && state.actionDelay) setTimeout(respond,state.actionDelay); else respond();
}
else fail('Unsupported fixture command');
`

const IPTABLES = `#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path');
const file=path.join(path.dirname(process.argv[1]),'firewall.json');
const state=JSON.parse(fs.readFileSync(file,'utf8'));
const args=process.argv.slice(2).filter(arg=>arg!=='-w');
const [op,chain,...tail]=args;
if(op==='-S') { if(!state[chain]) process.exit(1); console.log(state[chain].join('\\n')); }
else if(op==='-N') { state[chain]=[]; fs.writeFileSync(file,JSON.stringify(state)); }
else if(op==='-A' || op==='-I') {
 const rule=['-A',chain,...(op==='-I'?tail.slice(1):tail)].join(' ');
 if(op==='-I') state[chain].unshift(rule); else state[chain].push(rule);
 fs.writeFileSync(file,JSON.stringify(state));
} else process.exit(2);
`

export interface FixtureState {
  policy: boolean
  unavailable?: boolean
  actionDelay?: number
  containers: Record<string, unknown>
  volumes: Record<string, unknown>
}

export function dockerFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'cloud-worker-test-'))
  const executable = path.join(root, 'docker-fixture')
  writeFileSync(executable, DOCKER)
  chmodSync(executable, 0o700)
  const iptables = path.join(root, 'iptables-fixture')
  writeFileSync(iptables, IPTABLES)
  chmodSync(iptables, 0o700)
  writeFileSync(path.join(root, 'firewall.json'), JSON.stringify({ 'DOCKER-USER': [], INPUT: [] }))
  execFileSync('python3', [fileURLToPath(new URL('../cloud-computer-runtime/firewall-policy.py', import.meta.url)),
    'install', '--iptables', iptables])
  writeFileSync(path.join(root, 'trace.jsonl'), '')
  const write = (state: FixtureState) => writeFileSync(path.join(root, 'state.json'), JSON.stringify(state))
  const read = (): FixtureState => JSON.parse(readFileSync(path.join(root, 'state.json'), 'utf8'))
  write({ policy: true, containers: {}, volumes: {} })
  return { root, executable, iptables, read, write,
    clearFirewall: () => writeFileSync(path.join(root, 'firewall.json'), JSON.stringify({ 'DOCKER-USER': [], INPUT: [] })),
    trace: (): Array<{ args: string[]; input: string }> => readFileSync(path.join(root, 'trace.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line)) }
}
