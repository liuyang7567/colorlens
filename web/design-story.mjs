import { motionButton } from './motion.mjs';

const chapters = [
  { key: 'observe', label: '观察', title: '观察反应孔的显色变化', caption: '反应孔示意', text: '用眼镜记录实验现场，核对照片后插入实验正文。' },
  { key: 'record', label: '记录', title: '把照片写进实验记录', caption: '图文记录示例', text: '在文字之间插入原图，用时间线记下操作和观察。' },
  { key: 'analyze', label: '分析', title: '对照样本，比较颜色', caption: '区域选择示意', text: '框选照片中的样本区域比较色差，也可另行录入仪器读数。' }
];

export function mountAuthStory(gate, wordmark) {
  const header = document.createElement('header');
  header.className = 'auth-header';
  header.append(wordmark);
  const descriptor = document.createElement('span');
  descriptor.className = 'auth-platform-name';
  descriptor.textContent = '实验记录与分析平台';
  header.append(descriptor, motionButton());
  gate.prepend(header);

  const story = document.createElement('section');
  story.className = 'auth-story';
  story.setAttribute('aria-label', '镜析功能介绍');
  story.innerHTML = `
    <figure class="auth-example" data-scene="observe" aria-labelledby="story-title">
      <div class="story-layer story-observe" data-layer="observe">
        <picture><source type="image/webp" srcset="/plate-studio-720.webp 720w, /plate-studio.webp 1536w" sizes="(max-width: 780px) min(520px, 95vw), (max-width: 1500px) 55vw, 800px"><img src="/optics-hero.svg" width="1536" height="1024" fetchpriority="high" alt="透明反应孔中从琥珀色到浅黄色的溶液示意"></picture>
      </div>
      <div class="story-layer story-record" data-layer="record" hidden aria-hidden="true">
        <div class="story-sheet"><span>实验笔记</span><strong>显色观察记录</strong><div class="sheet-rule"></div><p>比较同一画面中的样本颜色。</p><div class="sheet-image"></div><p>已将观察与原图一同保存。</p></div>
      </div>
      <div class="story-layer story-analyze" data-layer="analyze" hidden aria-hidden="true"><img src="/optics-hero.svg" width="840" height="580" alt=""></div>
      <figcaption><span class="scene-caption">反应孔示意</span><h2 id="story-title">观察反应孔的显色变化</h2></figcaption>
    </figure>
    <div class="auth-story-controls"><div class="auth-feature-switch" role="group" aria-label="切换功能介绍"></div><p class="auth-feature-copy" aria-live="polite">用眼镜记录实验现场，核对照片后插入实验正文。</p></div>`;
  const figure = story.querySelector('figure');
  const controls = story.querySelector('.auth-feature-switch');
  const layers = Array.from(story.querySelectorAll('[data-layer]'));
  const title = figure.querySelector('h2');
  const caption = figure.querySelector('.scene-caption');
  const description = story.querySelector('.auth-feature-copy');
  for (const chapter of chapters) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = chapter.label;
    button.dataset.story = chapter.key;
    button.setAttribute('aria-pressed', String(chapter.key === 'observe'));
    button.addEventListener('click', () => {
      if (figure.dataset.scene === chapter.key) return;
      figure.dataset.scene = chapter.key;
      for (const layer of layers) layer.hidden = layer.dataset.layer !== chapter.key;
      for (const control of controls.children) control.setAttribute('aria-pressed', String(control === button));
      title.textContent = chapter.title;
      caption.textContent = chapter.caption;
      description.textContent = chapter.text;
    });
    controls.append(button);
  }
  gate.append(story);
}
