//! DFYOM's thin C ABI over cavalier_contours for wasm32-unknown-unknown (ADR 0019,
//! docs/decisions/0019-2d-geometry-library.md). No wasm-bindgen and no imports: the module needs
//! only its own memory, so every host instantiates it the same way. The TypeScript side is
//! src/core/geometry/2d/cavalier/binding.ts; change both together and bump `ABI_VERSION`.
//! Doc: docs/architecture/shapes.md#2d-port
//!
//! Buffers are f64 arrays in the module's memory:
//! `[loopCount, then per loop: flags, vertexCount, x, y, bulge, x, y, bulge, ...]`.
//! Input flags: bit 0 = closed. Output flags: bit 0 = closed, bit 1 = negative (a boolean's
//! subtracted space, or a clockwise loop of a shape offset).
//! Results are written to one internal buffer, read through `result_ptr()` and the returned length,
//! and valid until the next call.
//!
//! A panic aborts (a WASM trap); the TypeScript binding then discards the instance.

use cavalier_contours::polyline::{
    BooleanOp, PlineCreation, PlineOffsetOptions, PlineSource, PlineSourceMut, Polyline,
};
use cavalier_contours::shape_algorithms::{Shape, ShapeOffsetOptions};

/// Checked by the binding at load time.
const ABI_VERSION: u32 = 1;

static mut RESULT: Vec<f64> = Vec::new();

fn read_loops(ptr: *const f64, len: usize) -> Vec<Polyline<f64>> {
    let data = unsafe { core::slice::from_raw_parts(ptr, len) };
    let count = data[0] as usize;
    let mut i = 1;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let closed = (data[i] as u32) & 1 == 1;
        let n = data[i + 1] as usize;
        i += 2;
        let mut pl = Polyline::with_capacity(n, closed);
        for _ in 0..n {
            pl.add(data[i], data[i + 1], data[i + 2]);
            i += 3;
        }
        out.push(pl);
    }
    out
}

/// Writes `loops`; those from index `neg_start` on get the negative flag.
fn write_loops<'a>(
    loops: impl Iterator<Item = &'a Polyline<f64>>,
    count: usize,
    neg_start: usize,
) -> usize {
    #[allow(static_mut_refs)]
    let r = unsafe { &mut RESULT };
    r.clear();
    r.push(count as f64);
    for (i, pl) in loops.enumerate() {
        let neg = if i >= neg_start { 2.0 } else { 0.0 };
        r.push(neg + if pl.is_closed() { 1.0 } else { 0.0 });
        r.push(pl.vertex_count() as f64);
        for v in pl.iter_vertexes() {
            r.push(v.x);
            r.push(v.y);
            r.push(v.bulge);
        }
    }
    r.len()
}

#[no_mangle]
pub extern "C" fn abi_version() -> u32 {
    ABI_VERSION
}

/// A buffer of `len` f64 values; free it with `buf_free(ptr, len)`.
#[no_mangle]
pub extern "C" fn buf_alloc(len: usize) -> *mut f64 {
    let mut v = vec![0.0f64; len];
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

#[no_mangle]
pub extern "C" fn buf_free(ptr: *mut f64, len: usize) {
    unsafe { drop(Vec::from_raw_parts(ptr, len, len)) }
}

#[no_mangle]
pub extern "C" fn result_ptr() -> *const f64 {
    #[allow(static_mut_refs)]
    unsafe {
        RESULT.as_ptr()
    }
}

/// Offset of a shape (outer loops counter-clockwise, holes clockwise, none crossing); a positive
/// `offset` shrinks the filled area. Output: counter-clockwise loops, then clockwise ones (negative).
#[no_mangle]
pub extern "C" fn shape_offset(ptr: *const f64, len: usize, offset: f64) -> usize {
    let shape = Shape::from_plines(read_loops(ptr, len));
    let res = shape.parallel_offset(offset, &ShapeOffsetOptions::default());
    let ccw = res.ccw_plines.len();
    write_loops(
        res.ccw_plines
            .iter()
            .chain(res.cw_plines.iter())
            .map(|p| &p.polyline),
        ccw + res.cw_plines.len(),
        ccw,
    )
}

/// Offset of the first polyline (open or closed) with self-intersect handling; a positive
/// `offset` lies to the left of the direction of travel.
#[no_mangle]
pub extern "C" fn pline_offset(ptr: *const f64, len: usize, offset: f64) -> usize {
    let loops = read_loops(ptr, len);
    let opts = PlineOffsetOptions {
        handle_self_intersects: true,
        ..Default::default()
    };
    let res: Vec<Polyline<f64>> = loops[0].parallel_offset_opt(offset, &opts);
    write_loops(res.iter(), res.len(), res.len())
}

/// Boolean of the first two closed loops: op 0 = or, 1 = and, 2 = not (first minus second),
/// 3 = xor. Output: positive loops, then negative ones; orientation as the crate leaves it.
#[no_mangle]
pub extern "C" fn pline_boolean(ptr: *const f64, len: usize, op: u32) -> usize {
    let loops = read_loops(ptr, len);
    let op = match op {
        0 => BooleanOp::Or,
        1 => BooleanOp::And,
        2 => BooleanOp::Not,
        _ => BooleanOp::Xor,
    };
    let res = loops[0].boolean(&loops[1], op);
    let pos = res.pos_plines.len();
    write_loops(
        res.pos_plines
            .iter()
            .chain(res.neg_plines.iter())
            .map(|p| &p.pline),
        pos + res.neg_plines.len(),
        pos,
    )
}
