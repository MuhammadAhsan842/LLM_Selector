#!/bin/bash

# Make sure the script is executable
chmod +x download_ollama_models.sh

# Install the Ollama CLI if not already installed
if ! command -v ollama &> /dev/null; then
    echo "Ollama CLI not found. Installing..."
    ./install-cli.sh  # Run the installation script
else
    echo "Ollama CLI is already installed."
fi

# List of models to download
models=(
    
    "tinyllama"
    "neural-chat"
    "mistral"
    "codellama"
    "llama2-uncensored"
    "orca-mini"
    "llama2-chinese"
    "dolphin2.2-mistral"
}

    
)


for model in "${models[@]}"; do
    echo "Downloading model: $model..."
    ollama pull "$model"  
done

echo "All models downloaded successfully."
