fn main() {
    uniffi::generate_scaffolding("src/streampay.udl")
        .expect("generating UniFFI scaffolding from src/streampay.udl");
}
