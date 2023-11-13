
function hex(v: number, nd?: number) {
    if (!nd) nd = 2;
    return toradix(v, nd, 16);
}
function toradix(v: number, nd: number, radix: number) {
    try {
        var s = v.toString(radix).toUpperCase();
        while (s.length < nd)
            s = "0" + s;
        return s;
    } catch (e) {
        return v + "";
    }
}

type PixelEditorImageFormat = {
    w?: number
    h?: number
    count?: number
    bpp?: number
    np?: number
    bpw?: number
    sl?: number
    pofs?: number
    remap?: number[]
    brev?: boolean
    flip?: boolean
    destfmt?: PixelEditorImageFormat
    skip?: number
    yremap?: [number,number,number]
    bitremap?: number[]
};
function remapBits(x: number, arr?: number[]): number {
    if (!arr) return x;
    var y = 0;
    for (var i = 0; i < arr.length; i++) {
        var s = arr[i];
        if (s < 0) {
            s = -s - 1;
            y ^= 1 << s;
        }
        if (x & (1 << i)) {
            y ^= 1 << s;
        }
    }
    return y;
}
function convertImagesToWords(images: Uint8Array[], fmt: PixelEditorImageFormat): ArrayLike<number> {
    if (fmt.destfmt) fmt = fmt.destfmt;
    var width = fmt.w;
    var height = fmt.h;
    var count = fmt.count || 1;
    var bpp = fmt.bpp || 1;
    var nplanes = fmt.np || 1;
    var bitsperword = fmt.bpw || 8;
    var wordsperline = fmt.sl || Math.ceil(fmt.w * bpp / bitsperword);
    var mask = (1 << bpp) - 1;
    var pofs = fmt.pofs || wordsperline * height * count;
    var skip = fmt.skip || 0;
    var words;
    if (nplanes > 0 && fmt.sl) // TODO?
        words = new Uint8Array(wordsperline * height * count);
    else if (fmt.yremap)
        words = new Uint8Array(count * ((height>>fmt.yremap[0])*fmt.yremap[1] + (((1<<fmt.yremap[0])-1)*fmt.yremap[2])));
    else if (bitsperword <= 8)
        words = new Uint8Array(wordsperline * height * count * nplanes);
    else
        words = new Uint32Array(wordsperline * height * count * nplanes);
    for (var n = 0; n < count; n++) {
        var imgdata = images[n];
        var i = 0;
        for (var y = 0; y < height; y++) {
            var yp = fmt.flip ? height - 1 - y : y;
            var ofs0 = n * wordsperline * height + yp * wordsperline;
            if (fmt.yremap) { ofs0 = ((y>>fmt.yremap[0])*fmt.yremap[1]) + ((y&(1<<fmt.yremap[0])-1)*fmt.yremap[2]) }
            var shift = 0;
            for (var x = 0; x < width; x++) {
                var color = imgdata[i++];
                var ofs = remapBits(ofs0, fmt.remap);
                if (fmt.bitremap) {
                    for (var p = 0; p < (fmt.bpp || 1); p++) {
                        if (color & (1 << p))
                            words[ofs] |= 1 << fmt.bitremap[shift + p];
                    }
                } else {
                    for (var p = 0; p < nplanes; p++) {
                        var c = (color >> (p * bpp)) & mask;
                        words[ofs + p * pofs + skip] |= (fmt.brev ? (c << (bitsperword - shift - bpp)) : (c << shift));
                    }
                }
                shift += bpp;
                if (shift >= bitsperword) {
                    ofs0 += 1;
                    shift = 0;
                }
            }
        }
    }
    return words;
}
function concatArrays(arrays: Uint8Array[]): Uint8Array {
    var total = 0;
    arrays.forEach((a) => { total += a.length });
    var dest = new Uint8Array(total);
    total = 0;
    arrays.forEach((a) => { dest.set(a, total); total += a.length });
    return dest;
}
function exportFrameBuffer(img: PixelsAvailableMessage, settings: DithertronSettings): Uint8Array {
    var fmt = settings.exportFormat;
    if (!fmt) throw "No export format";
    fmt.w = img.width;
    fmt.h = img.height;
    return new Uint8Array(convertImagesToWords([img.indexed], fmt));
}
function exportApple2HiresToHGR(img: PixelsAvailableMessage, settings: DithertronSettings): Uint8Array {
    // TODO: handle other dimensions
    var data = new Uint8Array(0x2000);
    var srcofs = 0;
    for (var y = 0; y < img.height; y++) {
        var destofs = (y & 7) * 0x400 + ((y >> 3) & 7) * 0x80 + (y >> 6) * 0x28;
        for (var x = 0; x < img.width; x += 7) {
            var z = 0;
            var hibit = 0;
            for (var i = 0; i < 7; i++) {
                var col = img.indexed[srcofs++];
                if (col == 3 || col == 4) hibit |= 0x80;
                if (col >= 3) col -= 2;
                z |= (col << i * 2);
            }
            data[destofs++] = (z & 0x7f) | hibit;
            data[destofs++] = ((z >> 7) & 0x7f) | hibit;
        }
    }
    return data;
}
// TODO: support VIC-20
function exportCharMemory(img: PixelsAvailableMessage, 
    w: number, 
    h: number, 
    type?:'zx'|'fli',
    bgColor?:number) : Uint8Array 
{
    var bpp = (w == 4) ? 2 : 1; // C64-multi vs C64-hires & ZX
    var i = 0;
    var cols = img.width / w;
    var rows = img.height / h;
    var char = new Uint8Array(img.width * img.height * bpp / 8);
    var isvdp = char.length == img.params.length; // VDP mode (8x1 cells)
    if (type == 'fli') isvdp = true;
    console.log('isvdp', isvdp, w, h, bpp, cols, rows);
    for (var y = 0; y < img.height; y++) {
        for (var x = 0; x < img.width; x++) {
            var vdpofs = Math.floor(x / w) + y * cols;
            var charofs = Math.floor(x / w) + Math.floor(y / h) * cols;
            var ofs = charofs * h + (y & (h - 1));
            if (type=='zx')
                ofs = (vdpofs & 0b1100000011111) | ((vdpofs & 0b11100000) << 3) | ((vdpofs & 0b11100000000) >> 3);
            var shift = (x & (w - 1)) * bpp;
            shift = 8 - bpp - shift; // reverse bits
            var palidx = img.indexed[i];
            var idx = 0; // for bit pattern % 0 or %00
            var param = isvdp ? img.params[vdpofs] : img.params[charofs];
            if (bpp == 1) {
                if (palidx == (param & 0xf))
                    idx = 1; // for bit pattern %1
            } else {
                if (palidx == (param & 0xf)) // lower nibble
                    idx = 2; // for bit pattern %10
                else if (palidx == ((param >> 4) & 0xf)) // upper nibble
                    idx = 1; // for bit pattern %01
                else if (palidx == ((param >> 8) & 0xf)) // color block nibble
                    idx = 3; // for bit pattern %11
            }

            // Force override that the color choice MUST be the background color
            // if the palette index matches the background color even if one of
            // the other colors might happen to be set to the background color too.
            // This is requires as the FLI bug on C64s will choose the last color
            // block color as 0xff (grey) even if another color is specified but
            // will correctly choose the screen color if the pixel index is 0.
            // But the right block color might be set to the background color too
            // which would cause a match to the color block color/screen colors
            // instead of the background color as required for the FLI bug.
            if ((bgColor != undefined) && (bgColor === palidx))
                idx = 0;

            char[ofs] |= idx << shift;
            i++;
        }
    }
    return char;
}
function exportC64Multi(img: PixelsAvailableMessage, settings: DithertronSettings): Uint8Array {
    if (!settings.block) throw "No block size";
    let w = settings.block.w;
    let h = settings.block.h;
    let cols = img.width / w;
    let rows = img.height / h;

    let isUsingFli = !(settings.fli === undefined);
    let cbOffset : number = (img.width/w * img.height/h);
    let cbw : number = settings.cb.w === undefined ? w : settings.cb.w;
    let cbh : number = settings.cb.h === undefined ? h : settings.cb.h;

    let cbcols = img.width / cbw;
    let cbrows = img.height / cbh;

    let screen = new Uint8Array(isUsingFli ? 0x2000 : (cols * rows));
    let color = new Uint8Array(cbcols * cbrows);

    // Normally in multi-color mode each screen pixel in a 4x8 block choses from two
    // color options from screen ram which stores color palette choice one is the
    // lower screen nybble and color choice two in the upper screen nybble. However,
    // in FLI mode each pixel row gets a new choice of colors since on each scan line
    // special code swaps the screen color ram pointer location to a new location in
    // memory thus allowing for independent values per row.
    if (isUsingFli) {
        for (let i = 0; i < cbOffset; i++) {
            let p = img.params[i];
            let scrnofs = (Math.floor(i/40)&7)*0x400 + Math.floor(i/320)*40 + (i % 40);
            //if (i < 500) console.log(scrnofs, i, hex(i), (Math.floor(i/40)&7), ((Math.floor(i/40)&7)*0x400), (Math.floor(i/320)), (i % 40), (Math.floor(i/320)*40 + (i % 40)));
            screen[scrnofs] = (p & 0xff);
        }
    } else {
        for (let i = 0; i < screen.length; i++) {
            screen[i] = (img.params[i] & 0xff);
        }
    }

    for (let i = 0; i < color.length; i++) {
        // The FLI version separates out the color block ram from the
        // normal param area whereas the non-FLI version stores the
        // color block in the 2nd most least significant byte's lower
        // of each chosen color. In both cases, the color block area
        // is exactly the same size since they represent the pixel index
        // value choice of %11 and the color block ram is not relocatable
        // on the C64 (unlike the screen ram color choices).
        color[i] = (img.params[i + cbOffset] & 0xf);
    }
    let char = exportCharMemory(img, w, cbh, isUsingFli ? 'fli': undefined, (img.params[img.params.length-1] & 0xf));
    let xtraword = img.params[img.params.length - 1]; // background, border colors
    let xtra = new Uint8Array(2);
    xtra[0] = xtraword & 0xff;          // background color
    xtra[1] = (xtraword >> 8) & 0xff;   // border color
    return concatArrays([char, screen, color, xtra]);
}
function exportC64Hires(img: PixelsAvailableMessage, settings: DithertronSettings): Uint8Array {
    if (!settings.block) throw "No block size";
    let w = settings.block.w;
    let h = settings.block.h;
    let cols = img.width / w;
    let rows = img.height / h;
    let screen = new Uint8Array(cols * rows);
    for (let i = 0; i < screen.length; i++) {
        let p = img.params[i];
        screen[i] = ((p & 0x0f) << 4) | ((p & 0xf0) >> 4);
    }
    let char = exportCharMemory(img, w, h);
    let xtra = new Uint8Array(2);
    let xtraword = img.params[img.params.length - 1]; // background, border colors
    xtra[0] = xtraword & 0xff;          // background color
    xtra[1] = (xtraword >> 8) & 0xff;   // border color
    return concatArrays([char, screen, xtra]);
}
function exportC64HiresFLI(img: PixelsAvailableMessage, settings: DithertronSettings): Uint8Array {
    let screen = new Uint8Array(0x2000);
    for (var i = 0; i < img.params.length; i++) {
        let p = img.params[i];
        let scrnofs = (Math.floor(i/40)&7)*0x400 + Math.floor(i/320)*40 + (i % 40);
        screen[scrnofs] = ((p & 0x0f) << 4) | ((p & 0xf0) >> 4);
    }
    let xtra = new Uint8Array(2);
    let xtraword = img.params[img.params.length - 1]; // background, border colors
    xtra[0] = xtraword & 0xff;          // background color (and high nybble aux)
    xtra[1] = (xtraword >> 8) & 0xff;   // border color
    let char = exportCharMemory(img, 8, 8, 'fli');
    return concatArrays([char, screen, xtra]);
}
function exportVicHires(img: PixelsAvailableMessage, settings: DithertronSettings): Uint8Array {
    // TODO:Test this with actual asm code, consider this pre-experimental and likely to fail in practice
    if (!settings.block) throw "No block size";
    let w = settings.block.w;
    let h = settings.block.h;
    let cols = img.width / w;
    let rows = img.height / h;
    let screen = new Uint8Array(cols * rows);
    for (let i = 0; i < screen.length; i++) {
        let p = img.params[i];
        screen[i] = ((p & 0x0f) << 4) | ((p & 0xf0) >> 4);
    }
    // see exportVicMulti for more details
    let char = exportCharMemory(img, w, h);
    let xtra = new Uint8Array(2);
    let xtraword = img.params[img.params.length - 1]; // background, border colors
    xtra[0] = xtraword & 0xff;          // background color (and high nybble aux)
    xtra[1] = (xtraword >> 8) & 0xff;   // border color
    return concatArrays([char, screen, xtra]);
}
function exportVicMulti(img: PixelsAvailableMessage, settings: DithertronSettings): Uint8Array {
    // TODO:Test this with actual asm code, consider this pre-experimental and likely to fail in practice
    if (!settings.block) throw "No block size";

    let w = settings.block.w;
    let h = settings.block.h;
    let cols = img.width / w;
    let rows = img.height / h;

    let screen = new Uint8Array(cols * rows);

    // From wiki entry that best describes:
    // The VIC-20 lacks any true graphic mode, but a 22×11 text mode with 200 definable characters of
    // 8×16 bits each arranged as a matrix of 20×10 characters is usually used instead,
    // giving a 3:2(NTSC)/5:3(PAL) pixel aspect ratio, 160×160 pixels, 8-color "high-res mode" or
    // a 3:1(NTSC)/10:3(PAL) pixel aspect ratio, 80×160 pixels, 10-color "multicolor mode".
    //
    // In the 8-color high-res mode, every 8×8 pixels can have the background color (shared for the
    // entire screen) or a free foreground color, both selectable among the first eight colors of the
    // palette. In the 10-color multicolor mode, a single pixel of every 4×8 block (a character cell)
    // may have any of four colors: the background color, the auxiliary color (both shared for the
    // entire screen and selectable among the entire palette), the same color as the overscan border
    // (also a shared color) or a free foreground color, both selectable among the first eight colors
    // of the palette.
    for (let i = 0; i < screen.length; i++) {
        screen[i] = (img.params[i] & 0xff);
    }

    let char = exportCharMemory(img, w, h);
    let xtraword = img.params[img.params.length - 1]; // background, border colors
    let xtra = new Uint8Array(3);
    xtra[0] = xtraword & 0x0f;          // background color
    xtra[1] = (xtraword >> 8) & 0x0f;   // border color
    xtra[2] = (xtraword >> 4) & 0x0f;   // aux color
    return concatArrays([char, screen, xtra]);
}

function exportZXSpectrum(img: PixelsAvailableMessage, settings: DithertronSettings): Uint8Array {
    var screen = new Uint8Array(img.params.length);
    for (var i = 0; i < screen.length; i++) {
        var p = img.params[i] & 0xffff;
        screen[i] = (p & 0x7) | ((p >> 5) & 0x38) | 0x40; // 3 bits each, bright
    }
    var char = exportCharMemory(img, 8, 8, 'zx');
    return concatArrays([char, screen,]);
}
function exportTMS9918(img: PixelsAvailableMessage, settings: DithertronSettings): Uint8Array {
    if (!settings.block) throw "No block size";
    var w = settings.block.w;
    var h = settings.block.h;
    var cols = img.width / w;
    var rows = img.height / h;
    var screen = new Uint8Array(cols * rows); // 32 x 192
    for (var i = 0; i < screen.length; i++) {
        // x[0..4] y[0..7] -> y[0..2] x[0..4] y[3..7]
        var p = img.params[i] & 0xffff;
        var x = i & 31;
        var y = i >> 5;
        var ofs = (y & 7) | (x << 3) | ((y >> 3) << 8);
        screen[ofs] = (p << 4) | (p >> 8);
    }
    //console.log(img.params, screen);
    var char = exportCharMemory(img, 8, 8);
    return concatArrays([char, screen]);
}
function exportNES(img: PixelsAvailableMessage, settings: DithertronSettings): Uint8Array {
    var i = 0;
    var cols = img.width / 8;
    var rows = img.height / 8;
    var char = new Uint8Array(img.width * img.height * 2 / 8);
    for (var y = 0; y < img.height; y++) {
        for (var x = 0; x < img.width; x++) {
            var charofs = Math.floor(x / 8) + Math.floor(y / 8) * cols;
            var ofs = charofs * 16 + (y & 7);
            var shift = 7 - (x & 7);
            var idx = img.indexed[i];
            char[ofs] |= (idx & 1) << shift;
            char[ofs + 8] |= ((idx >> 1) & 1) << shift;
            i++;
        }
    }
    return char;
}
function exportNES5Color(img: PixelsAvailableMessage, settings: DithertronSettings): Uint8Array {
    if (!settings.block) throw "No block size";
    var char = exportFrameBuffer(img, settings);
    // TODO: attr block format
    var fmt = { w: settings.block.w, h: settings.block.h, bpp: 2 };
    var attr = new Uint8Array(convertImagesToWords([img.indexed], fmt));
    return concatArrays([char, attr]);
}
function exportVCSPlayfield(img: PixelsAvailableMessage, settings: DithertronSettings): Uint8Array {
    // must be == 40 pixels wide
    var char = new Uint8Array(6 * img.height);
    const pfmap = [
        3, 2, 1, 0, -1, -1, -1, -1,
        4, 5, 6, 7, 8, 9, 10, 11,
        19, 18, 17, 16, 15, 14, 13, 12,
        23, 22, 21, 20, -1, -1, -1, -1,
        24, 25, 26, 27, 28, 29, 30, 31,
        39, 38, 37, 36, 35, 34, 33, 32,
    ];
    for (var y = 0; y < img.height; y++) {
        for (var x = 0; x < 48; x++) {
            var srcofs = pfmap[x];
            if (srcofs >= 0) {
                srcofs += y * img.width;
                if (img.indexed[srcofs]) {
                    var destofs = (x >> 3) * img.height + img.height - y - 1;
                    char[destofs] |= 128 >> (x & 7);
                }
            }
        }
    }
    return char;
}

function exportMC6847(img: PixelsAvailableMessage, settings: DithertronSettings): Uint8Array {    
    var char = new Uint8Array(img.width*img.height/4);
    let dptr = 0;
    let sptr = 0;
    for (var y = 0; y < img.height; y++) {
        for (var x = 0; x < img.width; x+=4, sptr+=4) {
            char[dptr++] = ((img.indexed[sptr+0] & 0b11 ) << 6)+ 
                           ((img.indexed[sptr+1] & 0b11 ) << 4)+ 
                           ((img.indexed[sptr+2] & 0b11 ) << 2)+ 
                           ((img.indexed[sptr+3] & 0b11 ) << 0);
        }
    }
    console.log(char);
    return char;
}

//

function convertToSystemPalette(pal: Uint32Array, syspal: Uint32Array | number[]) {
    return pal.map((rgba) => syspal.indexOf(rgba & 0xffffff));
}

function getFilenamePrefix() {
    var fn = filenameLoaded || "image";
    try { fn = fn.split('.').shift() || "image"; } catch (e) { } // remove extension
    return fn + "-" + dithertron.settings.id;
}

function getNativeFormatData() {
    var img = dithertron.lastPixels;
    // TODO: yukky way to lookup a global function...
    let funcname = dithertron.settings.toNative;
    if (!funcname) return null;
    var fn = (window as any)[funcname];
    return img && fn && fn(img, dithertron.settings);
}
function downloadNativeFormat() {
    var data = getNativeFormatData();
    if (data != null) {
        var blob = new Blob([data], { type: "application/octet-stream" });
        saveAs(blob, getFilenamePrefix() + ".bin");
    }
}
function downloadImageFormat() {
    dest.toBlob((blob) => {
        saveAs(blob, getFilenamePrefix() + ".png");
    }, "image/png");
}
function byteArrayToString(data: number[] | Uint8Array): string {
    var str = "";
    if (data != null) {
        var charLUT = new Array();
        for (var i = 0; i < 256; ++i)
            charLUT[i] = String.fromCharCode(i);
        var len = data.length;
        for (var i = 0; i < len; i++)
            str += charLUT[data[i]];
    }
    return str;
}
function stringToByteArray(s: string): Uint8Array {
    var a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++)
        a[i] = s.charCodeAt(i);
    return a;
}
function getCodeConvertFunction(): () => string {
    var convertFuncName = 'getFileViewerCode_' + dithertron.settings.id.replace(/[^a-z0-9]/g, '_');
    // TODO: yukky
    console.log(convertFuncName);
    var convertFunc = (window as any)[convertFuncName];
    return convertFunc;
}
async function gotoIDE() {
    function addHiddenField(form:any, name:any, val:any) {
        $('<input type="hidden"/>').attr('name', name).val(val).appendTo(form);
    }
    if (confirm("Open code sample with image in 8bitworkshop?")) {
        //e.target.disabled = true;
        var platform_id = dithertron.settings.id.split('.')[0];
        var form = $((document.forms as any)['ideForm'] as HTMLFormElement);
        form.empty();
        if (platform_id == 'atari8') platform_id = 'atari8-800'; // TODO
        if (platform_id == 'cpc') platform_id = 'cpc.6128'; // TODO
        addHiddenField(form, "platform", platform_id);
        // TODO
        var codeFilename = "viewer-" + getFilenamePrefix() + ".asm";
        var dataFilename = getFilenamePrefix() + ".bin";
        addHiddenField(form, "file0_name", codeFilename);
        var code = getCodeConvertFunction()();
        code = code.replace("$DATAFILE", getFilenamePrefix() + ".bin");
        addHiddenField(form, "file0_data", code);
        addHiddenField(form, "file0_type", "utf8");
        addHiddenField(form, "file1_name", dataFilename);
        addHiddenField(form, "file1_data", btoa(byteArrayToString(getNativeFormatData())));
        addHiddenField(form, "file1_type", "binary");
        form.submit();
    }
}

//

function getFileViewerCode_c64_multi(): string {
    var code = `
    processor 6502
    include "basicheader.dasm"

Src equ $02
Dest equ $04

Start:
    lda #$3B   ; 25 rows, on, bitmap
    sta $d011  ; VIC control #1
    lda #$18   ; 40 column, multicolor
    sta $d016  ; VIC control #2
    lda #$02
    sta $dd00  ; set VIC bank ($4000-$7FFF)
    lda #$80
    sta $d018  ; set VIC screen to $6000
    lda XtraData+1
    sta $d020  ; border
    lda XtraData+0
    sta $d021  ; background
    lda #0
    sta Dest
; copy char memory
    lda #<CharData
    sta Src
    lda #>CharData
    sta Src+1
    lda #$40
    sta Dest+1
    ldx #$20
    jsr CopyMem
; copy screen memory
    lda #<ScreenData
    sta Src
    lda #>ScreenData
    sta Src+1
    lda #$60
    sta Dest+1
    ldx #$04
    jsr CopyMem
; copy color RAM
    lda #<ColorData
    sta Src
    lda #>ColorData
    sta Src+1
    lda #$d8
    sta Dest+1
    ldx #4
    jsr CopyMem
; infinite loop
    jmp .

; copy data from Src to Dest
; X = number of bytes * 256
CopyMem
    ldy #0
.Loop
    lda (Src),y
    sta (Dest),y
    iny
    bne .Loop
    inc Src+1
    inc Dest+1
    dex
    bne .Loop
    rts

; bitmap data
CharData equ .
ScreenData equ CharData+8000
ColorData equ ScreenData+1000
XtraData equ ColorData+1000
    incbin "$DATAFILE"
`;
    return code;
}

function getFileViewerCode_c64_hires(): string {
    var code = getFileViewerCode_c64_multi();
    code = code.replace('lda #$18', 'lda #$08').replace('multicolor', 'single');
    return code;
}

function getFileViewerCode_apple2_hires(): string {
    var code = `
    processor 6502
    seg Code
    org $803	; start of program
Start:
    sta $c050	; set graphics
    sta $c052	; no mixed mode
    sta $c057	; set hires
    jmp Start	; infinite loop

    org $2000	; start of hires page 1
    incbin "$DATAFILE"
`;
    return code;
}

function getFileViewerCode_nes(): string {
    var code = `

    include "nesdefs.dasm"

;;;;; VARIABLES

    seg.u ZEROPAGE
    org $0

;;;;; NES CARTRIDGE HEADER

    NES_HEADER 0,2,1,0 ; mapper 0, 2 PRGs, 1 CHR, horiz. mirror

;;;;; START OF CODE
Start:
; wait for PPU warmup; clear CPU RAM
; byte $02
    NES_INIT	; set up stack pointer, turn off PPU
    jsr WaitSync	; wait for VSYNC
    jsr ClearRAM	; clear RAM
    jsr WaitSync	; wait for VSYNC (and PPU warmup)
; set palette and nametable VRAM
    jsr SetPalette	; set palette colors
    jsr FillVRAM	; print message in name table
; reset PPU address and scroll registers
    lda #0
    sta PPU_ADDR
    sta PPU_ADDR	; PPU addr = $0000
    sta PPU_SCROLL
    sta PPU_SCROLL  ; PPU scroll = $0000
; activate PPU graphics
    lda #MASK_BG
    sta PPU_MASK 	; enable rendering
    lda #CTRL_NMI
    sta PPU_CTRL	; enable NMI
.endless
    jmp .endless	; endless loop

; set palette colors
SetPalette: subroutine
; set PPU address to palette start
    PPU_SETADDR $3f00
    ldy #0
.loop:
    lda Palette,y	; lookup byte in ROM
    sta PPU_DATA	; store byte to PPU data
    iny		; Y = Y + 1
    cpy #4		; is Y equal to max colors?
    bne .loop	; not yet, loop
    rts		; return to caller

; fill video RAM with "Hello World" msg
FillVRAM: subroutine
; set PPU address to name table A
    PPU_SETADDR $2106  ; row 8, col 6
    ldy #12		; # of rows
    lda #1		; first tile index
.nextrow
    ldx #20		; # of columns
.loop:
    sta PPU_DATA	; store+advance PPU
    clc
    adc #1
    dex
    bne .loop
    pha
    lda #$00	; blank
    REPEAT 12	; 32 - 20 = 12 cols/row
    sta PPU_DATA	; store+advance PPU
    REPEND
    pla
    dey
    bne .nextrow
.end
    rts		; return to caller

;;;;; COMMON SUBROUTINES

    include "nesppu.dasm"

;;;;; INTERRUPT HANDLERS

NMIHandler:
    rti		; return from interrupt

;;;;; CONSTANT DATA

Palette:
    hex 1f;screen color
    hex 01112100;background 0

;;;;; CPU VECTORS

    NES_VECTORS

;;;;; TILE SETS

    org $10000
    ds 16	; blanks
    incbin "$DATAFILE"
`;
    var palinds = convertToSystemPalette(dithertron.lastPixels.pal, dithertron.settings.pal);
    code = code.replace('hex 1f;screen color', 'hex ' + hex(palinds[0]));
    code = code.replace('hex 01112100;background 0', 'hex ' + hex(palinds[1]) + hex(palinds[2]) + hex(palinds[3]) + hex(0));
    return code;
}

function getFileViewerCode_msx(): string {
    var code = `
    ORG     04000H
; MSX cartridge header @ 0x4000 - 0x400f
    dw 0x4241
    dw Start
    dw Start
    dw 0,0,0,0,0

CHMOD   EQU   05fh
WRTVRM  EQU   04dh
LDIRVM  EQU   05ch

PATTERN equ 0h
NAME    equ 1800h
COLOR   equ 2000h

Start:
Data:
    ld a,2
    call CHMOD  ; screen mode 2
    ld bc,1800h
    ld hl,ImageData
    ld de,PATTERN
    call LDIRVM ; copy pattern table
    ld bc,1800h
    ld hl,ImageData+1800h
    ld de,COLOR
    call LDIRVM ; copy color table
Infinite:
    jmp Infinite ; loop forever

ImageData:
    incbin "$DATAFILE"
`;
    return code;
}

function getFileViewerCode_vcs(): string {
    var code = `
    processor 6502
    include "vcs.h"
    include "macro.h"
    include "xmacro.h"

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

    seg.u Variables
    org $80

    seg Code
    org $f000

Start
    CLEAN_START

NextFrame
    VERTICAL_SYNC

    TIMER_SETUP 37
; Set playfield foreground and background
    lda #$F6
    sta COLUBK
    lda #$F7
    sta COLUPF
    TIMER_WAIT

    ldy #192
ScanLoop
; WSYNC and store playfield registers
    sta WSYNC
    lda PFBitmap0,y
    sta PF0		; store first playfield byte
    lda PFBitmap1,y
    sta PF1		; store 2nd byte
    lda PFBitmap2,y
    sta PF2		; store 3rd byte
; Here's the asymmetric part -- by this time the TIA clock
; is far enough that we can rewrite the same PF registers
; and display new data on the right side of the screen
    nop
    nop
    nop		; pause to let playfield finish drawing
    lda PFBitmap3,y
    sta PF0		; store 4th byte
    lda PFBitmap4,y
    sta PF1		; store 5th byte
    lda PFBitmap5,y
    sta PF2		; store 6th byte
    dey 
    bne ScanLoop	; repeat until all scanlines drawn
; Reset playfield
    SLEEP 14	; give time to finish drawing scanline
    lda #0
    sta PF0
    sta PF1
    sta PF2		; clear playfield

    TIMER_SETUP 28
    TIMER_WAIT
    jmp NextFrame

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
; BITMAP DATA

PFBitmap0 equ .+192*0
PFBitmap1 equ .+192*1
PFBitmap2 equ .+192*2
PFBitmap3 equ .+192*3
PFBitmap4 equ .+192*4
PFBitmap5 equ .+192*5
    incbin "$DATAFILE"

; Epilogue
    org $fffc
    .word Start
    .word Start
`;
    var palinds = convertToSystemPalette(dithertron.lastPixels.pal, dithertron.settings.pal);
    code = code.replace('#$F6', '#$' + hex(palinds[0]));
    code = code.replace('#$F7', '#$' + hex(palinds[1]));
    return code;
}

function getFileViewerCode_astrocade(): string {
    var code = `

    INCLUDE "hvglib.h"      ; Include HVGLIB library
    ORG     FIRSTC          ; Initialize at beginning of cartridge ROM area
    DB      $55             ; ... with the code for a normal menued cartridge
    DW      MENUST          ; Initialize menu
    DW      PrgName         ; ... with string at PrgName
    DW      PrgStart        ; ... such that selecting the program enters PrgStart
PrgName:    DB      "BITMAP VIEWER" ; String
    DB      0               ; ... which must be followed by 0
PrgStart:   DI                      ; Disable interrupts
    SYSTEM  INTPC           ; Begin interpreter mode
    DO      SETOUT          ; Set output ports
    DB      98*2            ; ... with VBLANK line set to line 98
    DB      160/4           ; ... with color boundary
    DB      00001000b       ; ... with screen interrupts reenabled 
    DO      COLSET          ; Set color palettes
    DW      Palettes        ; ... with the values at Palettes
    DO      MOVE            ; Move memory
    DW      NORMEM          ; ... destination start of screen
    DW      40*98           ; ... number of bytes
    DW      BitmapData      ; ... source in ROM
    EXIT                    ; Exit interpreter mode
Loop:
    JP      Loop            ; Play infinite loop
Palettes:
    DB      $b3,$b2,$b1,$b0 ; Left color palette (11b, 10b, 01b, 00b)
    DB      $c3,$c2,$c1,$c0 ; Right color palette (11b, 10b, 01b, 00b)
BitmapData:
    incbin "$DATAFILE"
`;
var palinds = convertToSystemPalette(dithertron.lastPixels.pal, dithertron.settings.pal);
code = code.replace('$b0', '$' + hex(palinds[0]));
code = code.replace('$b1', '$' + hex(palinds[1]));
code = code.replace('$b2', '$' + hex(palinds[2]));
code = code.replace('$b3', '$' + hex(palinds[3]));
return code;
}

function getFileViewerCode_atari8_d() {
    var code = `
    processor 6502    
    include "atari.inc"
;GPIOMODE equ 1
    org     $a000           ;Start of left cartridge area
Start:
 ifconst GPIOMODE
    lda     #$80
    sta     GPRIOR
; set GTIA mode colors
    lda     #$00;PF4
    sta     COLOR0 + 0
    lda     #$00;PF5
    sta     COLOR0 + 1
    lda     #$00;PF6
    sta     COLOR0 + 2
    lda     #$00;PF7
    sta     COLOR0 + 3
    lda     #$00;PF8
    sta     COLOR0 + 4
 endif
; set non-GTIA mode colors
    lda     #$00;PF0
    sta     COLOR0+4
    lda     #$00;PF1
    sta     COLOR0+0
    lda     #$00;PF2
    sta     COLOR0+1
    lda     #$00;PF3
    sta     COLOR0+2
; set display list
    lda     #<dlist            ;Set Display list pointer
    sta     SDLSTL
    lda     #>dlist
    sta     SDLSTH
; enable DMI
    lda     #$22            ;Enable DMA
    sta     SDMCTL
; infinite loop
wait
    nop
    jmp     wait

;Graphics data
    align $100   ; ANTIC can only count to $FFF
ImgData1:
ImgData2 equ ImgData1+40*96
    incbin "$DATAFILE"

;Display list data
dlist
    .byte $70,$70,$70
    .byte $4d,#<ImgData1,#>ImgData1
    REPEAT 95
    .byte $0d
    REPEND
    ifconst GPIOMODE
    .byte $4f,#<ImgData2,#>ImgData2
    REPEAT 95
    .byte $0f
    REPEND
    endif
    .byte $41,$00,$10
dlistend equ .

;Cartridge footer
    org     CARTCS
    .word 	Start	; cold start address
    .byte	$00	; 0 == cart exists
    .byte	$04	; boot cartridge
    .word	Start	; start
`;
    var palinds = convertToSystemPalette(dithertron.lastPixels.pal, dithertron.settings.pal);
    for (var i=0; i<palinds.length; i++)
        code = code.replace('$00;PF'+i, '$' + hex(palinds[i]));
    return code;
}

function getFileViewerCode_atari8_f_10() {
    let code = getFileViewerCode_atari8_d();
    code = code.replace('.byte $4d','.byte $4f');
    code = code.replace('.byte $0d','.byte $0f');
    code = code.replace('#$00;PRIOR','#$80');
    code = code.replace('COLOR0+4', 'PCOLR0+0');
    code = code.replace('COLOR0+0', 'PCOLR0+1');
    code = code.replace('COLOR0+1', 'PCOLR0+2');
    code = code.replace('COLOR0+2', 'PCOLR0+3');
    code = code.replace(';GPIOMODE equ 1', 'GPIOMODE equ 1');
    return code;
}

function getFileViewerCode_zx() {
var code = `
    org  0x5ccb     ; start of code
Start
    ld	de,0x4000   ; DE = screen
    ld	hl,ImgData  ; HL = image data
    ld 	bc,0x1b00   ; 6144 bytes bitmap, 768 bytes attributes
    ldir            ; copy
Loop
    jp	loop        ; infinite loop

ImgData             ; data file
    incbin "$DATAFILE"

    org 0xff57
    defb 00h        ; end of ROM
`;
    return code;
}

// https://www.cpcwiki.eu/index.php/BIOS_Screen_Functions
// http://www.cpcmania.com/Docs/Programming/Painting_pixels_introduction_to_video_memory.htm
// https://www.cpcwiki.eu/index.php/CPC_Palette
function getFileViewerCode_cpc(mode: number) {
    var code = `
    org  0x4000     ; start of code
Start:
    ld  a,$MODE		; graphics mode
    call 0xbc0e		; SCR_SET_MODE
; set border color
    ld  hl,PalData
    ld  b,(hl)
    ld  c,b
    call 0xbc38		; SCR_SET_BORDER
    ld  b,0x10		; loop counter
; read palette from memory
    ld  hl,PalData+15
Loop1:
    push hl
    push bc
    ld  a,b
    dec a
    and a,0x0f
    ld  b,(hl)
    ld  c,b
    call 0xbc32		; SCR_SET_INK
    pop bc
    pop hl
    dec hl
    djnz Loop1
; set image bytes
    ld	de,0xc000   ; DE = screen
    ld	hl,ImgData  ; HL = image data
    ld 	bc,0x4000   ; BC = # of bytes   
    ldir            ; copy
Loop:
    jp	loop        ; infinite loop
PalData:
    db $c0,$c1,$c2,$c3,$c4,$c5,$c6,$c7
    db $c8,$c9,$c10,$c11,$c12,$c13,$c14,$c15
ImgData:            ; data file
    incbin "$DATAFILE"
`;
    var palinds = convertToSystemPalette(dithertron.lastPixels.pal, dithertron.settings.pal);
    code = code.replace('$MODE', mode+"");
    for (var i=0; i<16; i++)
        code = code.replace('$c'+i, '$' + hex(palinds[i] || 0));
    return code;
}

function getFileViewerCode_cpc_mode0(mode: number) {
    return getFileViewerCode_cpc(0);
}

function getFileViewerCode_cpc_mode1(mode: number) {
    return getFileViewerCode_cpc(1);
}

function getFileViewerCode_c64_fli(): string {
    var code = `

    processor 6502
    include "basicheader.dasm"
    
; credit to https://codebase64.org/doku.php?id=base:fli_displayer

; The chips emulator has a VIC graphics timing bug which
; differs from other emulators (such as VICE). Setting
; this value to 1 allows the emulator bug to be worked
; around while 0 allows other systems to work.
Use8BitWorkshopEmulator equ 1

; Use the repeat command to generate the lookup
; tables instead of using a code generator by
; specifying 0. Using 1 will include table generation
; code.
UseInitTables equ 0

; This code is extremely similar between multi-color
; graphics mode and hires graphcis mode. Setting
; to 1 enables the multi-color graphics code, otherwise
; set to 0 for hires graphics mode.
UseMultiColorGraphics equ $USE_MULTI_MODE

#if Use8BitWorkshopEmulator
TweakD018 equ -1
TweakD011 equ 7
#else
TweakD018 equ 1
TweakD011 equ 1
#endif

Irq0AtRaster equ $2d

    ; temporary CopyMem storage variables in
    ; zero page

Src equ $02
Dest equ $04

Sys2062:
    jmp Start   ; entry point from basic

    ;-------------------------------------------------
    ; Start of code that must be within the
    ; same page boundary $nn00 -> $nnFF
    ; otherwise some instructions may become
    ; cycle inaccurate.
    
    .align $100
    .align $1
    
    ;
    ; Two IRQs are used to create a stable raster
    ; line start point free from issues caused by
    ; interrupts, inconsistent mid-instruction
    ; triggers, or other concerns.
    ;
    ; The first IRQ's job is to setup the second IRQ.
    ; While the first IRQ is triggers based on a
    ; raster line it's timing is not said to be as
    ; accurate becuase the CPU might be processing
    ; any possible cycle timed 1-7 clock cycle
    ; instructions, whereas the second IRQ is
    ; triggered only during a 2 clock cycle "nop"
    ; instruction ensuring the second IRQ is accurate
    ; within 0 or 1 clock cycle count.
    ; 
    ; The second IRQ further has logic to detect this
    ; 0 or 1 clock cycle count offset and correct the
    ; timing so the entry point into the raster
    ; routine is 100% accurate creating an accurate
    ; and stable raster-timed loop.
    ;
    
Irq0:
    pha
    lda $d019
    sta $d019
    inc $d012
    lda #<Irq1
    sta $fffe   ; set up 2nd IRQ to get a stable IRQ
    cli

    ;
    ; These "nop"s are not an accident, or in need
    ; of optimization. They allow the 2nd IRQ
    ; to be triggered with an off-by 0 or 1 clock
    ; cycle delay resulting in an "almost" stable IRQ.
    ;

    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
        
    ; The "rti" of the first Irq0 is not needed as
    ; these "nop" instructions never fall-through.
    ; The stack is re-arranged so that the second Irq1
    ; (which triggers while the first Irq0 is being
    ; serviced) returns to the interrupt point where
    ; the first trigger IRQ happened bypassing the
    ; need for a "rti" from the first Irq0 entirely.

Irq1:
Ntsc1:
    ; PAL raster at 9 or 10/46
    lda #$ea    ; modified to NOP NOP on NTSC
    lda #$80
    sta $d018   ; setup first color RAM address early
    lda #$38
    sta $d011   ; setup first DMA access early
    pla
    pla
    pla
    lda $d019
    sta $d019
    lda #Irq0AtRaster
    sta $d012
    lda #<Irq0
    sta $fffe   ; switch IRQ back to first stabilizer IRQ
    lda $d012   ; PAL raster at 55 or 56/46
    cmp $d012   ; stabilize last jittering cycle
    beq Delay   ; PAL raster at 0 or 1/47; if equal, 2 cycles delay. else 3 cycles delay

Delay:
    stx SaveX+1 ; PAL raster stable at 3/47 (no more fluctuations)
    ldx #$0d

Wait:
    dex
    bne Wait

Ntsc2:
    ; PAL raster at 10/48
    lda #$ea    ; modified to NOP NOP on NTSC
Ntsc3:
    lda #$ea    ; modified to NOP NOP on NTSC

    ;
    ; Following here is the main FLI loop which forces
    ; the VIC-II to read new color data each
    ; rasterline. The loop is exactly 23 clock cycles
    ; long so together with 40 cycles of color DMA this
    ; will result in the 63 clock cycles which is exactly
    ; the length of a PAL C64 rasterline.
    ;

    nop
    nop
L0:
    ; PAL raster at 61/48, 61/49, 61/50, ...
    lda LookupD018+TweakD018,x
    sta $d018   ; set new color RAM address
    lda LookupD011+TweakD011,x
    sta $d011   ; force new color DMA
    inx         ; FLI bug $D800 color = 8 (orange)
    cpx #199    ; last rasterline?
Ntsc4:
    bne L0      ; branches to l0-1 on NTSC for 2 extra cycles per rasterline

    ; lda $d016
    ; eor #$01    ; IFLI: 1 hires pixel shift every 2nd frame
    ; sta $d016
    ; lda $dd00
    ; eor #$02    ; IFLI: flip between banks $4000 and $C000 every frame
    ; sta $dd00

SaveX:
    ldx #$00
    pla
Nmi:
    rti

    ;
    ; End of code that must be within the
    ; same page boundary $nn00 -> $nnFF
    ; otherwise some instructions may become
    ; cycle inaccurate.
    ;-------------------------------------------------

Start:
    sei

    jsr CopyData
    jsr InitGfx
    jsr InitTables
    jsr NtscFix
    
    ; Patch the table as the last line needs to
    ; perform the "open borders" trick. This trick
    ; involves an undocumented "feature" where multi
    ; color mode graphics is enabled with extended
    ; background mode. While documented as not a
    ; legal combination, this combination causes the
    ; borders to be open to writing during the
    ; raster scroll process (otherwise some of the
    ; rows would be shifted an "off"). This patching
    ; needs to be done within the timing of the final
    ; scan line otherwise the normal background is
    ; disturbed and the drawing is not correct. The
    ; screen needs to be turned off to ensure the
    ; background is painted during the final scene.
    ; Unfortunately the final row is cut-off
    ; for a 319 instead of 320 pixel count height.
    ; A fix is welcomed for this issue.

    lda LookupD011+199
    and #$07
    ora #$70
    sta LookupD011+199

    ; The VIC chip doesn't care if ram or rom is
    ; selected (with an exception), but the IRQs
    ; cannot be overridden later unless ram is loaded.
    ; Thus the kernal routines are not available while
    ; the picture is being displayed, and if the
    ; kernal rom is to be used, the IRQs must first be
    ; uninstalled prior to accessing the kernal
    ; functions and rom restored.
    
    lda #$35    ; %x01: RAM visible at $A000-$BFFF and $E000-$FFFF.
                ; %1xx: I/O area visible at $D000-$DFFF. (Except for the value %100, see above.)
    sta $01     ; disable ROMs %xxxxx101 (rest are default values)
    lda #$7f
    sta $dc0d   ; no CIA #1 timer IRQs
    lda $dc0d   ; clear CIA #1 timer IRQ flags

    lda #$2b
    sta $d011   ; %00101011 - neutral scroll, 25 rows, screen off, bitmap mode, raster IRQ high bit zero
    lda #Irq0AtRaster
    sta $d012   ; interrupt at raster line 45

    ; Even though these IRQ values overrite screen
    ; color choice area of the picture data, this
    ; does not affect the picture in any way
    ; because the color choices end at 1000 bytes,
    ; not 1024 bytes leaving the extra few bytes
    ; unused by the VIC chip, which is fortunately
    ; exactly where IRQ vectors need to be installed.
    ;
    ; However, care must be taken that if a new
    ; picture is loaded into this memory area then the
    ; IRQ table needs to be re-initialzed to these
    ; default values and interrupts (including NMIs)
    ; must be disabled during the picture copying
    ; process. NMIs cannot technically be disabled,
    ; but a trick can be used where a NMI can be
    ; intentionally triggered without acknowledgement
    ; thus preventing a second NMI from happening.
    
    lda #<Nmi
    sta $fffa
    lda #>Nmi
    sta $fffb   ; dummy NMI to avoid crashing due to RESTORE
    lda #<Irq0
    sta $fffe
    lda #>Irq0
    sta $ffff   ; Irq0 is the default interrupt handler
    lda #$01
    sta $d01a   ; enable raster IRQs (no other IRQs)

                ; dec op reads the value, writes the value back
                ; "as is" unmodified, then writes the value back
                ; modified guaranteeing bit 0 is cleared
    dec $d019   ; clear raster IRQ flag (so it can trigger)
    cli
    jmp *       ; that's it, no more action needed
    
CopyData:

    ; The VIC always reads the bitmap and screen color
    ; choices from RAM regardless if the ram or roms
    ; are active (with the exception of %xxxxx0xx and
    ; the exception to the exception being %xxxxx000).
    ; The color block data always is read from
    ; I/O $d800 area.
    
                ; %x00: RAM visible in all three areas.
                ; %x00: RAM visible in all three areas.
    lda #$30    ; %00110000
    sta $01     ; enable HIMEM RAM
    
    ; copy char memory
    lda #<CharData
    sta Src
    lda #>CharData
    sta Src+1
    lda #0
    sta Dest
    lda #$c0
    sta Dest+1
    ldx #$20
    jsr CopyMem
    
    ; copy screen memory
    lda #<ScreenData
    sta Src
    lda #>ScreenData
    sta Src+1
    lda #0
    sta Dest
    lda #$e0
    sta Dest+1
    ldx #$20
    jsr CopyMem
    
    lda #$07   ; %x11: BASIC ROM visible at $A000-$BFFF; KERNAL ROM visible at $E000-$FFFF.
               ; %1xx: I/O area visible at $D000-$DFFF.
    sta $01    ; enable ROM and $D000 I/O
    
#if UseMultiColorGraphics
    ; copy color block RAM to the VIC's color block area
    lda #<ColorData
    sta Src
    lda #>ColorData
    sta Src+1
    lda #$d8
    sta Dest+1
    ldx #4
    jsr CopyMem
#endif
    rts

InitGfx:
    lda #$00
    sta $d015   ; disable sprites

    lda XtraData+1
    sta $d020   ; border
    lda XtraData+0
    sta $d021   ; background

#if UseMultiColorGraphics
    lda #$D8    ; multi-color mode on
#else
    lda #$C8    ; multi-color mode off
#endif
    sta $d016   ; %00011000 ; no horizontal scroll, 40 columns, multimode on or off, defaulted high bits
    lda #$80
    sta $d018   ; %10000000 ; bitmap data %0xx, 0: +$0000-$1FFF, 0-8191; screen color choices +$2000-$23FF, 8192-9215.
    lda #$00
    sta $dd00   ; %00, 0: Bank #3, $C000-$FFFF, 49152-65535.
    rts

    ; The InitTables routine can be removed if your
    ; assembler supports a .repeat-style macro.
    ; The code is only included as an example of how
    ; to initialize the tables in the event your
    ; assembler does not have a suitable substitute.

InitTables:
#if UseInitTables
    ldx #$00
L2:
    txa
    asl
    asl
    asl
    asl
    and #$70    ; color RAMs at $E000
    ora #$80    ; bitmap data at $C000
    sta LookupD018,x ; calculate $D018 table
    txa
    and #$07
    ora #$38    ; bitmap
    sta LookupD011,x ; calculate $D011 table
    inx
    bne L2
#endif
    rts
        
NtscFix:
    bit $d011
    bmi *-3
    bit $d011   ; wait for rasterline 256
    bpl *-3
    lda #$00
Test:
    cmp $d012
    bcs Nt
    lda $d012   ; get rasterline low byte
Nt:
    bit $d011
    bmi Test
    cmp #$20    ; PAL: $37, NTSC: $05 or $06
    bcs Pal

    ; 
    ; This code self-patches to support NTSC mode
    ; which means this code must be copied to RAM
    ; if the code is originally located in ROM.
    ; If this code must run from ROM then the code
    ; needs to be duplicated with a PAL and an
    ; NTSC version where the test routine installs
    ; one or the other versions for usage.
    ;

    ; 
    ; The value "#$ea" as a literal is the op
    ; code for "nop", so when the instruction
    ; "lda #$ea" is patched, it becomes the values
    ; "$ea $ea" (i.e. "nop" and "nop").
    ;
    ; In such a patch, the clock cycle count
    ; changes from a 2-clock cycle "lda" immediate
    ; mode instruction into a 4-clock cycle timed
    ; instructions
    ;

    lda #$ea
    sta Ntsc1
    sta Ntsc2
    sta Ntsc3
    dec Ntsc4+1
Pal:
    rts

; copy data from Src to Dest
; X = number of bytes * 256 bytes at a time
CopyMem:
    ldy #0
.Loop:
    lda (Src),y
    sta (Dest),y
    iny
    bne .Loop
    inc Src+1
    inc Dest+1
    dex
    bne .Loop
    rts

    .align $100

; lookup table for $d011
LookupD011:
#if UseInitTables
    .ds 256
#else
    .repeat 256/8
    .byte $38,$39,$3a,$3b,$3c,$3d,$3e,$3f
    .repend
#endif
    
; lookup table for $d018
LookupD018:
#if UseInitTables
    .ds 256
#else
    .repeat 256/8
    .byte $80,$90,$a0,$b0,$c0,$d0,$e0,$f0
    .repend
#endif

    .align $100
CharData equ .
ScreenData equ CharData+8000
#if UseMultiColorGraphics
ColorData equ ScreenData+$2000
XtraData equ ColorData+1000
#else
XtraData equ ScreenData+$2000
#endif

    ; link a demo picture
    incbin "$DATAFILE"
`;
    return code;
}


function getFileViewerCode_c64_hires_fli(): string {
    let code = getFileViewerCode_c64_fli();
    code = code.replace("$USE_MULTI_MODE", "0");
    return code;
}

function getFileViewerCode_c64_hires_fli_bug(): string {
    let code = getFileViewerCode_c64_fli();
    code = code.replace("$USE_MULTI_MODE", "0");
    return code;
}

function getFileViewerCode_c64_hires_fli_blank(): string {
    let code = getFileViewerCode_c64_fli();
    code = code.replace("$USE_MULTI_MODE", "0");
    return code;
}

function getFileViewerCode_c64_multi_fli(): string {
    let code = getFileViewerCode_c64_fli();
    code = code.replace("$USE_MULTI_MODE", "1");
    return code;
}

function getFileViewerCode_c64_multi_fli_bug(): string {
    let code = getFileViewerCode_c64_fli();
    code = code.replace("$USE_MULTI_MODE", "1");
    return code;
}

function getFileViewerCode_c64_multi_fli_blank(): string {
    let code = getFileViewerCode_c64_fli();
    code = code.replace("$USE_MULTI_MODE", "1");
    return code;
}

function getFileViewerCode_c64_multi_fli_blank_left(): string {
    let code = getFileViewerCode_c64_fli();
    code = code.replace("$USE_MULTI_MODE", "1");
    return code;
}
