#include <ZXing/ReadBarcode.h>
#include <ZXing/CreateBarcode.h>
#include <ZXing/ReaderOptions.h>
#include <ZXing/Barcode.h>
#include <ZXing/Error.h>
#include <ZXing/ImageView.h>
#include <vector>
#include <cstdint>
#include <cstdlib>
#include <string>
#include <new>

using namespace ZXing;

#define WASM_EXPORT(name) __attribute__((export_name(#name)))

struct TranspilerContext {
    std::vector<uint8_t> matrix_buffer;
    std::string decoded_text;
    int matrix_dimension = 0;
    int error_state = 0;
};

static int reconstruct_matrix(TranspilerContext* ctx, const std::string& text, const char* ec_level) {
    std::string config_payload = std::string("ecLevel=") + ec_level;
    CreatorOptions create_opts(BarcodeFormat::QRCode, config_payload); 

    try {
        Barcode new_barcode = CreateBarcodeFromText(text, create_opts);
        ImageView matrix = new_barcode.symbol();
        
        ctx->matrix_dimension = matrix.width();
        ctx->matrix_buffer.assign(ctx->matrix_dimension * ctx->matrix_dimension, 0);
        
        for (int y = 0; y < ctx->matrix_dimension; ++y) {
            for (int x = 0; x < ctx->matrix_dimension; ++x) {
                ctx->matrix_buffer[y * ctx->matrix_dimension + x] = (*matrix.data(x, y) == 0) ? 1 : 0;
            }
        }
        ctx->error_state = 0;
        return 1; 
    } catch (...) {
        ctx->error_state = -1;
        return -1; 
    }
}

extern "C" {
    WASM_EXPORT(allocate_buffer) void* allocate_buffer(size_t size) { 
        return std::malloc(size); 
    }
    
    WASM_EXPORT(free_buffer) void free_buffer(void* ptr) { 
        std::free(ptr); 
    }

    WASM_EXPORT(create_context) TranspilerContext* create_context() {
        return new (std::nothrow) TranspilerContext();
    }

    WASM_EXPORT(destroy_context) void destroy_context(TranspilerContext* ctx) {
        delete ctx;
    }

    WASM_EXPORT(get_decoded_text_ptr) const char* get_decoded_text_ptr(TranspilerContext* ctx) { 
        return ctx ? ctx->decoded_text.c_str() : nullptr; 
    }
    
    WASM_EXPORT(get_decoded_text_len) int get_decoded_text_len(TranspilerContext* ctx) { 
        return ctx ? static_cast<int>(ctx->decoded_text.length()) : 0; 
    }

    WASM_EXPORT(get_error_state) int get_error_state(TranspilerContext* ctx) {
        return ctx ? ctx->error_state : -1;
    }

    WASM_EXPORT(transpile_qr) int transpile_qr(TranspilerContext* ctx, uint8_t* lum_buffer, int width, int height, int binarizer_mode) {
        if (!ctx || !lum_buffer) return 0;

        ImageView image{lum_buffer, width, height, ImageFormat::Lum};
        Binarizer bin = (binarizer_mode == 1) ? Binarizer::LocalAverage : Binarizer::GlobalHistogram;
        
        ReaderOptions read_opts = ReaderOptions()
            .formats(BarcodeFormat::QRCode)
            .tryHarder(true)
            .tryInvert(true)
            .tryDownscale(true)
            .returnErrors(true)
            .binarizer(bin);
        
        Barcode result = ReadBarcode(image, read_opts);
        
        if (result.isValid()) {
            ctx->decoded_text = result.text();
            return reconstruct_matrix(ctx, ctx->decoded_text, "H");
        }

        if (result.error()) {
            switch(result.error().type()) {
                case Error::Type::Format: ctx->error_state = -3; break;
                case Error::Type::Checksum: ctx->error_state = -4; break;
                case Error::Type::Unsupported: ctx->error_state = -1; break;
                default: ctx->error_state = -1; break;
            }
        } else {
            ctx->error_state = -2;
        }
        
        return 0;
    }

    WASM_EXPORT(validate_qr) int validate_qr(TranspilerContext* ctx, uint8_t* lum_buffer, int width, int height, int binarizer_mode) {
        if (!ctx || !lum_buffer) return 0;

        ImageView image{lum_buffer, width, height, ImageFormat::Lum};
        Binarizer bin = (binarizer_mode == 1) ? Binarizer::LocalAverage : Binarizer::GlobalHistogram;
        
        ReaderOptions read_opts = ReaderOptions()
            .formats(BarcodeFormat::QRCode)
            .tryHarder(true)
            .tryInvert(true)
            .tryDownscale(true)
            .returnErrors(true)
            .binarizer(bin);
        
        Barcode result = ReadBarcode(image, read_opts);
        
        if (result.isValid()) {
            ctx->decoded_text = result.text();
            ctx->error_state = 0;
            return 1;
        }

        if (result.error()) {
            switch(result.error().type()) {
                case Error::Type::Format: ctx->error_state = -3; break;
                case Error::Type::Checksum: ctx->error_state = -4; break;
                case Error::Type::Unsupported: ctx->error_state = -1; break;
                default: ctx->error_state = -1; break;
            }
        } else {
            ctx->error_state = -2;
        }
        
        return 0;
    }

    WASM_EXPORT(generate_qr_dynamic) int generate_qr_dynamic(TranspilerContext* ctx, uint8_t* text_buffer, int length, int ecc_tier) {
        if (!ctx || !text_buffer) return 0;

        ctx->decoded_text.assign(reinterpret_cast<const char*>(text_buffer), length);
        
        const char* ecc = "M"; 
        switch (ecc_tier) {
            case 0: ecc = "L"; break;
            case 1: ecc = "M"; break;
            case 2: ecc = "Q"; break;
            case 3: ecc = "H"; break;
            default: ecc = "M"; break;
        }
        
        return reconstruct_matrix(ctx, ctx->decoded_text, ecc);
    }

    WASM_EXPORT(get_matrix_buffer) uint8_t* get_matrix_buffer(TranspilerContext* ctx) { 
        return ctx ? ctx->matrix_buffer.data() : nullptr; 
    }
    
    WASM_EXPORT(get_matrix_dimension) int get_matrix_dimension(TranspilerContext* ctx) { 
        return ctx ? ctx->matrix_dimension : 0; 
    }
}
