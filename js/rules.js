export class Rules{
  constructor(){
    this.KEYWORDS = [
      {k:/ELEV(?:ATOR|\.|\b)/i, type:'ELEVATOR'},
      {k:/STAIR/i, type:'STAIR'},
      {k:/WOMEN|LADIES|WOMEN\'S|WOMAN|GIRLS|W\.?C\.?/i, type:'WOMENS_RR'},
      {k:/MEN|MEN\'S|BOYS|MENS|M\.?C\.?/i, type:'MENS_RR'},
      {k:/TOILET|RESTROOM|BATH/i, type:'RESTROOM'},
      {k:/ELECTRICAL/i, type:'ELECTRICAL'},
      {k:/DATA|IT CLOSET|IDF|MDF/i, type:'DATA'},
      {k:/EXIT/i, type:'EXIT'},
      {k:/LOBBY/i, type:'LOBBY'},
      {k:/MECHANICAL|JANITOR|CUSTOD(IAL|IAN)/i, type:'BOH_MISC'},
      {k:/YOGA/i, type:'YOGA'},
      {k:/PR\s*FIT|PRFIT/i, type:'PR_FIT'}
    ];
  }
  deriveRoomNumber(text){ const m = text.match(/\b[AC]?(\d{1,4})(?:[-\. ]?\d{1,3})?\b/); return m?m[0]:''; }
  deriveRoomFromText(text){ return this.deriveRoomNumber(text); }
  defaultRoomNameFor(signType){
    switch((signType||'').toUpperCase()){
      case 'INGRESS':
      case 'EGRESS': return 'STAIR';
      case 'HALL DIRECT':
      case 'CALLBOX':
      case 'EVAC': return 'ELEV. LOBBY';
      default: return '';
    }
  }
  apply(text, project, preset){
    const before = project.schedule.length;
    const pushRow = (SignType, RoomNumber, RoomName, Notes='')=>{
      project.schedule.push({SignType, RoomNumber, RoomName, Building:project.building||'', Level:project.level||'', Notes});
    };
    const L1only = (project.level||'').toString().trim()==='1';
    for(const kw of this.KEYWORDS){
      if(!kw.k.test(text)) continue;
      switch(kw.type){
        case 'ELEVATOR':
          if(preset==='southwood'){
            pushRow('CALLBOX','1-100','ELEV. LOBBY','Auto');
            pushRow('EVAC','1-100','ELEV. LOBBY','Auto');
            pushRow('HALL DIRECT','C1-100','ELEV. LOBBY','Door to lobby');
          } else { pushRow('ELEVATOR LOBBY','','ELEVATOR LOBBY','Auto'); }
          break;
        case 'STAIR':
          pushRow('INGRESS', this.deriveRoomNumber(text)||'', 'STAIR','Auto');
          pushRow('EGRESS', this.deriveRoomNumber(text)||'', 'STAIR','Auto');
          break;
        case 'WOMENS_RR': pushRow('FOH', this.deriveRoomNumber(text)||'', "WOMEN'S RESTROOM", 'Auto'); break;
        case 'MENS_RR':   pushRow('FOH', this.deriveRoomNumber(text)||'', "MEN'S RESTROOM", 'Auto'); break;
        case 'RESTROOM':  pushRow('FOH', this.deriveRoomNumber(text)||'', 'RESTROOM', 'Auto'); break;
        case 'ELECTRICAL':pushRow('BOH', this.deriveRoomNumber(text)||'', 'ELECTRICAL', 'Auto'); break;
        case 'DATA':      pushRow('BOH', this.deriveRoomNumber(text)||'', 'DATA', 'Auto'); break;
        case 'EXIT':      if(L1only) pushRow('EXIT','', 'EXIT', 'Level 1 only'); break;
        case 'BOH_MISC':  pushRow('BOH', this.deriveRoomNumber(text)||'', 'MECH/JANITORIAL', 'Auto'); break;
        case 'YOGA':      pushRow('FOH', this.deriveRoomNumber(text)||'', 'YOGA', 'Auto'); break;
        case 'PR_FIT':    pushRow('FOH', this.deriveRoomNumber(text)||'', 'PR FIT', 'Auto'); break;
      }
    }
    // Dedupe
    const key=r=>[r.SignType,r.RoomNumber,r.RoomName,r.Building,r.Level].join('|');
    const map=new Map(); project.schedule.forEach(r=>{ map.set(key(r), r) }); project.schedule=[...map.values()];
    return project.schedule.length - before;
  }
  validate(project){
    const issues=[]; const rows=project.schedule; const level=(project.level||'').toString().trim();
    const elevItems=['CALLBOX','EVAC','HALL DIRECT'];
    const elevRooms=new Map();
    rows.filter(r=>elevItems.includes(r.SignType.toUpperCase())).forEach(r=>{
      const k=r.RoomName||'ELEV. LOBBY'; const set=elevRooms.get(k)||new Set(); set.add(r.SignType.toUpperCase()); elevRooms.set(k,set);
    });
    elevRooms.forEach((set,room)=>{ elevItems.forEach(req=>{ if(!set.has(req)) issues.push(`Elevator bundle incomplete in ${room}: missing ${req}`); }); });
    const stairMap=new Map();
    rows.filter(r=>['INGRESS','EGRESS'].includes(r.SignType.toUpperCase())).forEach(r=>{
      const k=r.RoomNumber||'?'; const set=stairMap.get(k)||new Set(); set.add(r.SignType.toUpperCase()); stairMap.set(k,set);
    });
    stairMap.forEach((set,room)=>{ ['INGRESS','EGRESS'].forEach(req=>{ if(!set.has(req)) issues.push(`Stair ${room}: missing ${req}`); }); });
    rows.filter(r=>r.SignType.toUpperCase()==='EXIT').forEach(r=>{ if(level!=='1') issues.push('EXIT present but project level is not 1'); });
    rows.filter(r=>['ELECTRICAL','DATA'].includes((r.RoomName||'').toUpperCase())).forEach(r=>{ if((r.SignType||'').toUpperCase()!=='BOH') issues.push(`${r.RoomName}: should be BOH`); });
    return issues;
  }
}
