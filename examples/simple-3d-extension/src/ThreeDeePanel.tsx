import { PanelExtensionContext, RenderState } from "@foxglove/studio";
import {
  AmbientLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PointLight,
  Scene,
  SphereGeometry,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";

// Sets up our panel and our context onRender function.
function setup3dPanel(context: PanelExtensionContext) {
  // Create core scene components.
  const renderer = new WebGLRenderer();
  renderer.setClearColor(0x111111, 1);

  const rootRect = context.panelElement.getBoundingClientRect();
  renderer.setSize(rootRect.width, rootRect.height);
  context.panelElement.appendChild(renderer.domElement);

  const camera = new PerspectiveCamera(45, rootRect.width / rootRect.height, 1, 500);
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);

  const scene = new Scene();

  const geometry = new SphereGeometry(15, 32, 16);
  const material = new MeshStandardMaterial({
    color: "purple",
    wireframe: true,
    metalness: 0.5,
    roughness: 0.5,
  });
  const sphere = new Mesh(geometry, material);
  scene.add(sphere);

  const pointLight = new PointLight(0xffffff, 10, 100);
  pointLight.position.set(50, 50, 50);
  scene.add(pointLight);

  const ambientLight = new AmbientLight(0x404040, 1);
  scene.add(ambientLight);

  // Add orbit controls for interaction.
  const controls = new OrbitControls(camera, renderer.domElement);

  // Our onRender function just calls done immediately in this case
  // since rendering is happening in three.
  context.onRender = (_renderState: RenderState, done) => {
    done();
  };

  // We need to watch something in the context so our render function gets called.
  context.watch("currentTime");

  // Setup our simple animation loop.
  function animate() {
    controls.update();
    renderer.render(scene, camera);

    requestAnimationFrame(animate);
  }

  animate();
}

export function initThreeDeePanel(context: PanelExtensionContext): void {
  setup3dPanel(context);
}
