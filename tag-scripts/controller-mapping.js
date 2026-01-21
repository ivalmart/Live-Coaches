// <controller-mapping> web component stub
class ControllerMapping extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode: 'open'});
    this.showing = false;
    this.render();
  }
  render() {
    this.shadowRoot.innerHTML = `
      <link rel="stylesheet" href="../style.css" />
      <button id="toggle">${this.showing ? 'Hide' : 'Show'} Controls</button>
      <div class="mapping" style="display:${this.showing ? 'block' : 'none'}">
        <div>
          <b>Keyboard Controls :</b>
          <span class="keyboard">Key Input</span> Controller Input &nbsp;
          <br><br>
          <span class="keyboard">W</span> Up &nbsp;
          <span class="keyboard">S</span> Down &nbsp;
          <span class="keyboard">A</span> Left &nbsp;
          <span class="keyboard">D</span> Right &nbsp;
          <br>
          <span class="keyboard">P</span> A &nbsp;
          <span class="keyboard">L</span> B &nbsp;
          <span class="keyboard">O</span> X &nbsp;
          <span class="keyboard">K</span> Y &nbsp;
          <br>
          <span class="keyboard">Q</span> L &nbsp;
          <span class="keyboard">E</span> R &nbsp;
          <br>
          <span class="keyboard">Shift</span> Select &nbsp;
          <span class="keyboard">Enter</span> Start
        </div>
      </div>
    `;
    
    this.shadowRoot.getElementById('toggle').onclick = () => {
      this.showing = !this.showing;
      this.render();
    };
  }
}
customElements.define('controller-mapping', ControllerMapping);
