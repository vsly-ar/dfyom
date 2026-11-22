//! Spike S1 (docs/decisions/0019-2d-geometry-library.md): a minimal C ABI over cavalier_contours
//! for wasm32-unknown-unknown. No wasm-bindgen, no imports: the module needs only its own memory.
//!
//! Buffer format (f64): [loopCount, then per loop: flags (bit 0 closed, bit 1 boolean hole),
//! vertexCount, x, y, bulge, ...].
//! Results are written to an internal buffer read through `result_ptr()` and the returned length.

use cavalier_contours::polyline::{
    BooleanOp, PlineCreation, PlineOffsetOptions, PlineSource, PlineSourceMut, Polyline,
};
use cavalier_contours::shape_algorithms::{Shape, ShapeOffsetOptions};

static mut RESULT: Vec<f64> = Vec::new();

fn read_loops(ptr: *const f64, len: usize) -> Vec<Polyline<f64>> {
    let data = unsafe { core::slice::from_raw_parts(ptr, len) };
    let count = data[0] as usize;
    let mut i = 1;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let closed = data[i] != 0.0;
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

/// `neg_start`: loops from this index on are boolean holes (flag 2 or 3 instead of 0 or 1).
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

/// Shape offset (outer loops CCW, islands CW); positive offset shrinks the filled area.
#[no_mangle]
pub extern "C" fn shape_offset(ptr: *const f64, len: usize, offset: f64) -> usize {
    let shape = Shape::from_plines(read_loops(ptr, len));
    let res = shape.parallel_offset(offset, &ShapeOffsetOptions::default());
    let count = res.ccw_plines.len() + res.cw_plines.len();
    write_loops(
        res.ccw_plines
            .iter()
            .chain(res.cw_plines.iter())
            .map(|p| &p.polyline),
        count,
        count,
    )
}

/// Single polyline offset with self-intersect handling.
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

/// Boolean of the first two loops: op 0 = or, 1 = and, 2 = not, 3 = xor. Positive loops first,
/// then negative (hole) loops, flagged; the crate does not normalise their orientation.
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
    let count = res.pos_plines.len() + res.neg_plines.len();
    write_loops(
        res.pos_plines
            .iter()
            .chain(res.neg_plines.iter())
            .map(|p| &p.pline),
        count,
        res.pos_plines.len(),
    )
}
