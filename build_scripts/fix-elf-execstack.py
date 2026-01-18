#!/usr/bin/env python3
"""
Fix executable stack flag in ELF binaries.

WHY THIS SCRIPT EXISTS:
-----------------------
ONNX Runtime's pre-compiled .so files are built with an "executable stack" flag.
Steam Deck's security-hardened kernel blocks such libraries, causing the error:

    "cannot enable executable stack as shared object requires: Invalid argument"

This script removes the executable flag from the PT_GNU_STACK segment:
    p_flags: 0x7 (RWX) → 0x6 (RW-)

WHY IT RUNS DURING BUILD:
- Steam Deck's filesystem is read-only for plugins
- Tools like execstack/patchelf aren't installed by default
- Decky plugins can't modify their own binaries at runtime

This script is called automatically by build-zip.js when creating the plugin package.

TECHNICAL DETAILS:
This script modifies the PT_GNU_STACK program header in ELF files
to remove the executable stack flag (PF_X), which causes
"cannot enable executable stack as shared object requires" errors
on systems with strict security settings.

Usage:
    python fix-elf-execstack.py <path_to_so_file_or_directory>
"""

import os
import struct
import sys
from pathlib import Path


# ELF constants
ELF_MAGIC = b'\x7fELF'
PT_GNU_STACK = 0x6474e551
PF_X = 0x1  # Execute permission flag
PF_W = 0x2  # Write permission flag
PF_R = 0x4  # Read permission flag


def is_elf_file(filepath):
    """Check if a file is an ELF binary."""
    try:
        with open(filepath, 'rb') as f:
            magic = f.read(4)
            return magic == ELF_MAGIC
    except (IOError, OSError):
        return False


def fix_elf_execstack(filepath):
    """
    Remove executable stack flag from ELF file.

    Returns:
        True if file was modified, False otherwise
    """
    if not is_elf_file(filepath):
        return False

    with open(filepath, 'r+b') as f:
        # Read ELF header
        f.seek(0)
        e_ident = f.read(16)

        if e_ident[:4] != ELF_MAGIC:
            return False

        # Check if 32-bit or 64-bit
        ei_class = e_ident[4]
        is_64bit = (ei_class == 2)

        # Check endianness
        ei_data = e_ident[5]
        is_little_endian = (ei_data == 1)
        endian = '<' if is_little_endian else '>'

        if is_64bit:
            # 64-bit ELF header
            # e_phoff at offset 32, e_phentsize at 54, e_phnum at 56
            f.seek(32)
            e_phoff = struct.unpack(endian + 'Q', f.read(8))[0]
            f.seek(54)
            e_phentsize = struct.unpack(endian + 'H', f.read(2))[0]
            e_phnum = struct.unpack(endian + 'H', f.read(2))[0]

            # Program header entry format for 64-bit:
            # p_type (4), p_flags (4), p_offset (8), p_vaddr (8),
            # p_paddr (8), p_filesz (8), p_memsz (8), p_align (8)
            phdr_struct = endian + 'IIQQQQQQ'
            flags_offset = 4  # p_flags is at offset 4 in 64-bit phdr
        else:
            # 32-bit ELF header
            # e_phoff at offset 28, e_phentsize at 42, e_phnum at 44
            f.seek(28)
            e_phoff = struct.unpack(endian + 'I', f.read(4))[0]
            f.seek(42)
            e_phentsize = struct.unpack(endian + 'H', f.read(2))[0]
            e_phnum = struct.unpack(endian + 'H', f.read(2))[0]

            # Program header entry format for 32-bit:
            # p_type (4), p_offset (4), p_vaddr (4), p_paddr (4),
            # p_filesz (4), p_memsz (4), p_flags (4), p_align (4)
            phdr_struct = endian + 'IIIIIIII'
            flags_offset = 24  # p_flags is at offset 24 in 32-bit phdr

        # Scan program headers for PT_GNU_STACK
        modified = False
        for i in range(e_phnum):
            phdr_offset = e_phoff + (i * e_phentsize)
            f.seek(phdr_offset)

            # Read p_type
            p_type = struct.unpack(endian + 'I', f.read(4))[0]

            if p_type == PT_GNU_STACK:
                # Found PT_GNU_STACK, check flags
                if is_64bit:
                    f.seek(phdr_offset + 4)  # p_flags at offset 4 for 64-bit
                else:
                    f.seek(phdr_offset + 24)  # p_flags at offset 24 for 32-bit

                p_flags = struct.unpack(endian + 'I', f.read(4))[0]

                if p_flags & PF_X:
                    # Has executable flag, remove it
                    new_flags = p_flags & ~PF_X

                    if is_64bit:
                        f.seek(phdr_offset + 4)
                    else:
                        f.seek(phdr_offset + 24)

                    f.write(struct.pack(endian + 'I', new_flags))
                    modified = True
                    print(f"  Fixed: {filepath}")
                    print(f"    Changed p_flags from 0x{p_flags:x} to 0x{new_flags:x}")

                break

        return modified


def process_path(path):
    """Process a file or directory recursively."""
    path = Path(path)

    if not path.exists():
        print(f"Error: Path does not exist: {path}")
        return 0

    fixed_count = 0

    if path.is_file():
        if path.suffix == '.so' or '.so.' in path.name:
            if fix_elf_execstack(path):
                fixed_count += 1
    elif path.is_dir():
        # Find all .so files recursively
        for so_file in path.rglob('*.so'):
            if fix_elf_execstack(so_file):
                fixed_count += 1

        # Also handle versioned .so files (e.g., libfoo.so.1.2.3)
        for so_file in path.rglob('*.so.*'):
            if fix_elf_execstack(so_file):
                fixed_count += 1

    return fixed_count


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        print("Error: Please provide a path to an ELF file or directory.")
        sys.exit(1)

    total_fixed = 0
    for path in sys.argv[1:]:
        print(f"Processing: {path}")
        fixed = process_path(path)
        total_fixed += fixed

    print(f"\nTotal files fixed: {total_fixed}")

    if total_fixed > 0:
        print("Done! The executable stack flag has been removed.")
    else:
        print("No files needed fixing.")


if __name__ == '__main__':
    main()
