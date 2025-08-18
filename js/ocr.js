export class OCR{
  async recognize(dataUrl){
    const res = await Tesseract.recognize(dataUrl, 'eng');
    return res.data.text||'';
  }
}
