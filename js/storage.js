export class Store{
  constructor(key){ this.key=key; }
  async load(){ try{ return JSON.parse(localStorage.getItem(this.key))||[] }catch{ return [] } }
  save(projects){ localStorage.setItem(this.key, JSON.stringify(projects)); }
}
